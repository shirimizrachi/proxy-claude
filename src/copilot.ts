import { copilotHeaders } from "./constants.ts"
import type { ChatCompletionsPayload, CopilotResponseMeta, ModelsResponse } from "./types.ts"

export async function getModels(copilotToken: string, baseUrl: string): Promise<ModelsResponse> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: copilotHeaders(copilotToken),
  })

  if (!response.ok) {
    throw new Error(`Failed to get models: ${response.status}`)
  }

  return (await response.json()) as ModelsResponse
}

export async function createChatCompletions(
  payload: ChatCompletionsPayload,
  copilotToken: string,
  baseUrl: string,
): Promise<{ response: Response; meta: CopilotResponseMeta }> {
  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string" &&
      Array.isArray(x.content) &&
      x.content.some((p) => p.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(copilotToken, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new CopilotApiError(response.status, await response.text())
  }

  // Extract server-generated metadata from response headers
  const meta: CopilotResponseMeta = {
    requestId: response.headers.get("x-request-id") ?? undefined,
  }

  return { response, meta }
}

export class CopilotApiError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`Copilot API error: ${status}`)
    this.status = status
    this.body = body
  }
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() ?? ""

      for (const part of parts) {
        if (!part.trim()) continue

        let event: string | undefined
        const dataLines: string[] = []

        for (const line of part.split(/\r?\n/)) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim()
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim())
          }
        }

        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") }
        }
      }
    }

    // Flush remaining bytes from the decoder
    buffer += decoder.decode()

    if (buffer.trim()) {
      let event: string | undefined
      const dataLines: string[] = []

      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim())
        }
      }

      if (dataLines.length > 0) {
        yield { event, data: dataLines.join("\n") }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
