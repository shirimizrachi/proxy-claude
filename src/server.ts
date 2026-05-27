import http from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"

import { logToFile, formatError } from "./log.ts"
import { createChatCompletions, CopilotApiError, parseSSE } from "./copilot.ts"
import { translateToOpenAI, translateToAnthropic, translateOpenAIErrorToAnthropic } from "./translate.ts"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./translate-stream.ts"
import { buildTelemetryEvent } from "./telemetry.ts"
import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
  ChatCompletionChunk,
  ChatCompletionResponse,
  CopilotResponseMeta,
  TelemetryEvent,
} from "./types.ts"

const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10 MB

function readBody(
  req: http.IncomingMessage,
  maxSize: number = MAX_BODY_SIZE,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
      if (body.length > maxSize) {
        req.destroy()
        reject(new Error("Request body too large"))
      }
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function sendError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  const body = JSON.stringify({
    type: "error",
    error: { type, message },
  })
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(body)
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function isAuthValid(
  req: http.IncomingMessage,
  nonce: string,
): boolean {
  const apiKeyHeader = req.headers["x-api-key"]
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader
  if (typeof apiKey === "string" && safeEqual(apiKey, nonce)) return true

  const authHeader = req.headers["authorization"]
  const auth = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined
  if (typeof auth === "string" && safeEqual(auth, nonce)) return true

  return false
}

export function startServer(
  port: number,
  nonce: string,
  getCopilotToken: () => string,
  getCopilotBaseUrl: () => string,
  getModel?: () => string,
  onTelemetry?: (event: TelemetryEvent) => void,
  getUsername?: () => string,
  refreshToken?: () => Promise<boolean>,
  isTokenHealthy?: () => boolean,
): Promise<{ server: http.Server; port: number }> {
  const serverStartTime = Date.now()

  // In-memory session stats for /v1/stats endpoint
  const stats = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalErrors: 0,
    totalEstimatedCostUSD: 0,
    byModel: {} as Record<string, { requests: number; inputTokens: number; outputTokens: number }>,
  }

  function recordStats(event: TelemetryEvent): void {
    stats.totalRequests++
    stats.totalInputTokens += event.inputTokens
    stats.totalOutputTokens += event.outputTokens
    stats.totalCacheReadTokens += event.cacheReadTokens
    stats.totalEstimatedCostUSD = Math.round(
      (stats.totalEstimatedCostUSD + event.estimatedCostUSD) * 1_000_000,
    ) / 1_000_000
    if (!event.success) stats.totalErrors++

    if (!stats.byModel[event.model]) {
      stats.byModel[event.model] = { requests: 0, inputTokens: 0, outputTokens: 0 }
    }
    stats.byModel[event.model].requests++
    stats.byModel[event.model].inputTokens += event.inputTokens
    stats.byModel[event.model].outputTokens += event.outputTokens
  }

  const server = http.createServer(async (req, res) => {
    // Strip query string for route matching (e.g. ?beta=true)
    const pathname = (req.url ?? "/").split("?")[0]

    // Health check — reports token health so singleton check can detect a broken instance
    if (req.method === "GET" && pathname === "/") {
      const healthy = isTokenHealthy ? isTokenHealthy() : true
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: healthy ? "ok" : "token_unhealthy" }))
      return
    }

    // Session stats — requires auth (contains usage details)
    if (req.method === "GET" && pathname === "/v1/stats") {
      if (!isAuthValid(req, nonce)) {
        sendError(res, 401, "authentication_error", "Invalid authentication")
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        session: {
          startedAt: new Date(serverStartTime).toISOString(),
          uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
          totalRequests: stats.totalRequests,
          totalInputTokens: stats.totalInputTokens,
          totalOutputTokens: stats.totalOutputTokens,
          totalCacheReadTokens: stats.totalCacheReadTokens,
          totalErrors: stats.totalErrors,
          totalEstimatedCostUSD: Math.round(stats.totalEstimatedCostUSD * 10000) / 10000,
          byModel: stats.byModel,
        },
      }))
      return
    }

    // Models list — Claude Code calls GET /v1/models
    if (req.method === "GET" && pathname === "/v1/models") {
      if (!isAuthValid(req, nonce)) {
        sendError(res, 401, "authentication_error", "Invalid authentication")
        return
      }
      const modelId = getModel?.() ?? "claude-sonnet-4"
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        data: [
          {
            id: modelId,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "anthropic",
          },
        ],
        object: "list",
      }))
      return
    }

    // Single model lookup — Claude Code may call GET /v1/models/{id}
    if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
      if (!isAuthValid(req, nonce)) {
        sendError(res, 401, "authentication_error", "Invalid authentication")
        return
      }
      const modelId = decodeURIComponent(pathname.slice("/v1/models/".length))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        id: modelId,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic",
      }))
      return
    }

    // Count tokens — estimate from payload for context window tracking
    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      if (!isAuthValid(req, nonce)) {
        sendError(res, 401, "authentication_error", "Invalid authentication")
        return
      }
      try {
        const bodyStr = await readBody(req)
        const payload = JSON.parse(bodyStr) as AnthropicMessagesPayload
        const inputTokens = estimateTokenCount(payload)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ input_tokens: inputTokens }))
      } catch {
        // If parsing fails, return a conservative estimate
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ input_tokens: 1 }))
      }
      return
    }

    // Batches stub — Claude Code may call POST /v1/messages/batches
    if (pathname.startsWith("/v1/messages/batches")) {
      if (!isAuthValid(req, nonce)) {
        sendError(res, 401, "authentication_error", "Invalid authentication")
        return
      }
      await readBody(req)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: [], object: "list" }))
      return
    }

    // Messages endpoint
    if (req.method === "POST" && pathname === "/v1/messages") {
      if (!isAuthValid(req, nonce)) {
        sendError(res, 401, "authentication_error", "Invalid authentication")
        return
      }

      const requestStartTime = Date.now()
      const copilotBaseUrl = getCopilotBaseUrl()

      try {
        const bodyStr = await readBody(req)
        const anthropicPayload = JSON.parse(bodyStr) as AnthropicMessagesPayload
        const openAIPayload = translateToOpenAI(anthropicPayload)

        // Capture request metadata for telemetry
        const messageCount = anthropicPayload.messages.length
        const toolCount = anthropicPayload.tools?.length ?? 0
        const hasThinking = anthropicPayload.thinking?.type === "enabled"

        // Helper: attempt the Copilot API call, with one retry on 401 after token refresh
        const callCopilot = async (): Promise<{ response: Response; meta: CopilotResponseMeta }> => {
          try {
            return await createChatCompletions(openAIPayload, getCopilotToken(), getCopilotBaseUrl())
          } catch (error) {
            if (error instanceof CopilotApiError && error.status === 401 && refreshToken) {
              logToFile("Got 401 from Copilot API, attempting token refresh...")
              const refreshed = await refreshToken()
              if (refreshed) {
                logToFile("Token refreshed, retrying request...")
                return await createChatCompletions(openAIPayload, getCopilotToken(), getCopilotBaseUrl())
              }
            }
            throw error
          }
        }

        const { response, meta: copilotMeta } = await callCopilot()

        if (!anthropicPayload.stream) {
          // Non-streaming
          const openAIResponse =
            (await response.json()) as ChatCompletionResponse
          const anthropicResponse = translateToAnthropic(openAIResponse)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "x-request-id": randomUUID(),
          })
          res.end(JSON.stringify(anthropicResponse))

          // Emit telemetry for non-streaming request
          if (onTelemetry) {
            try {
              const usage = anthropicResponse.usage
              const event = buildTelemetryEvent({
                user: getUsername?.() ?? "unknown",
                model: anthropicPayload.model,
                stream: false,
                messageCount,
                toolCount,
                hasThinking,
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
                stopReason: anthropicResponse.stop_reason ?? "unknown",
                durationMs: Date.now() - requestStartTime,
                success: true,
                copilotApiUrl: copilotBaseUrl,
                copilotRequestId: copilotMeta.requestId,
                copilotCompletionId: openAIResponse.id,
                copilotModelServed: openAIResponse.model,
                systemFingerprint: openAIResponse.system_fingerprint,
              })
              recordStats(event)
              onTelemetry(event)
            } catch { /* telemetry must never break the proxy */ }
          }
        } else {
          // Streaming
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "x-request-id": randomUUID(),
          })

          const streamState: AnthropicStreamState = {
            messageStartSent: false,
            contentBlockIndex: 0,
            contentBlockOpen: false,
            toolCalls: {},
          }

          // Accumulate usage from streaming chunks for telemetry
          const streamUsage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            stopReason: "",
            completionId: "",
            modelServed: "",
            systemFingerprint: "",
          }

          let clientDisconnected = false
          let streamFailed = false
          let streamErrorType = ""
          res.on("close", () => {
            clientDisconnected = true
          })

          try {
            if (!response.body) {
              throw new Error("No response body for streaming")
            }

            for await (const rawEvent of parseSSE(response.body)) {
              if (clientDisconnected) break

              if (rawEvent.data === "[DONE]") {
                break
              }

              if (!rawEvent.data) {
                continue
              }

              const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

              // Capture provenance from first chunk (id, model, fingerprint are the same across chunks)
              if (!streamUsage.completionId && chunk.id) {
                streamUsage.completionId = chunk.id
              }
              if (!streamUsage.modelServed && chunk.model) {
                streamUsage.modelServed = chunk.model
              }
              if (!streamUsage.systemFingerprint && chunk.system_fingerprint) {
                streamUsage.systemFingerprint = chunk.system_fingerprint
              }

              // Capture usage from chunks for telemetry
              if (chunk.usage) {
                const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
                streamUsage.inputTokens = chunk.usage.prompt_tokens - cachedTokens
                streamUsage.outputTokens = chunk.usage.completion_tokens
                streamUsage.cacheReadTokens = cachedTokens
              }
              if (chunk.choices[0]?.finish_reason) {
                streamUsage.stopReason = chunk.choices[0].finish_reason
              }

              const events = translateChunkToAnthropicEvents(
                chunk,
                streamState,
              )

              for (const event of events) {
                if (clientDisconnected) break
                res.write(
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
              }
            }
          } catch (streamError) {
            streamFailed = true
            if (!clientDisconnected) {
              let errorType = "api_error"
              let errorMessage = "An unexpected error occurred during streaming."
              if (streamError instanceof CopilotApiError) {
                const translated = translateOpenAIErrorToAnthropic(streamError.status, streamError.body)
                errorType = translated.type
                errorMessage = translated.message
              } else if (streamError instanceof Error) {
                errorMessage = streamError.message
              }
              const errorEvent = translateErrorToAnthropicErrorEvent(errorType, errorMessage)
              res.write(
                `event: ${errorEvent.type}\ndata: ${JSON.stringify(errorEvent)}\n\n`,
              )
              logToFile(`Streaming error: ${formatError(streamError)}`)
              streamErrorType = errorType
            }
          }

          res.end()

          // Emit telemetry for streaming request
          if (onTelemetry) {
            try {
              const event = buildTelemetryEvent({
                user: getUsername?.() ?? "unknown",
                model: anthropicPayload.model,
                stream: true,
                messageCount,
                toolCount,
                hasThinking,
                inputTokens: streamUsage.inputTokens,
                outputTokens: streamUsage.outputTokens,
                cacheReadTokens: streamUsage.cacheReadTokens,
                cacheCreationTokens: 0, // OpenAI streaming chunks don't surface cache creation tokens
                stopReason: streamUsage.stopReason || "unknown",
                durationMs: Date.now() - requestStartTime,
                success: !streamFailed,
                copilotApiUrl: copilotBaseUrl,
                copilotRequestId: copilotMeta.requestId,
                copilotCompletionId: streamUsage.completionId || undefined,
                copilotModelServed: streamUsage.modelServed || undefined,
                systemFingerprint: streamUsage.systemFingerprint || undefined,
                errorType: streamFailed ? streamErrorType : undefined,
              })
              recordStats(event)
              onTelemetry(event)
            } catch { /* telemetry must never break the proxy */ }
          }
        }
      } catch (error) {
        if (error instanceof CopilotApiError) {
          const anthropicError = translateOpenAIErrorToAnthropic(error.status, error.body)
          const anthropicStatus = mapCopilotStatusToAnthropic(error.status)
          sendError(res, anthropicStatus, anthropicError.type, anthropicError.message)

          // Emit telemetry for error
          if (onTelemetry) {
            try {
              const event = buildTelemetryEvent({
                user: getUsername?.() ?? "unknown",
                model: "unknown",
                stream: false,
                messageCount: 0,
                toolCount: 0,
                hasThinking: false,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                stopReason: "",
                durationMs: Date.now() - requestStartTime,
                success: false,
                copilotApiUrl: copilotBaseUrl,
                errorType: anthropicError.type,
                errorStatus: error.status,
              })
              recordStats(event)
              onTelemetry(event)
            } catch { /* telemetry must never break the proxy */ }
          }
        } else {
          logToFile(`Request error: ${formatError(error)}`)
          sendError(res, 500, "api_error", "Internal server error")

          // Emit telemetry for unexpected error
          if (onTelemetry) {
            try {
              const event = buildTelemetryEvent({
                user: getUsername?.() ?? "unknown",
                model: "unknown",
                stream: false,
                messageCount: 0,
                toolCount: 0,
                hasThinking: false,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                stopReason: "",
                durationMs: Date.now() - requestStartTime,
                success: false,
                copilotApiUrl: copilotBaseUrl,
                errorType: "api_error",
                errorStatus: 500,
              })
              recordStats(event)
              onTelemetry(event)
            } catch { /* telemetry must never break the proxy */ }
          }
        }
      }
      return
    }

    // Not found — log the unhandled route for debugging
    logToFile(`Unhandled: ${req.method} ${req.url}`)
    sendError(res, 404, "not_found_error", "Not found")
  })

  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo
      resolve({ server, port: addr.port })
    })
  })
}

/**
 * Map Copilot/OpenAI HTTP status codes to appropriate Anthropic HTTP status codes.
 * The Anthropic API uses slightly different status codes for some error types.
 */
function mapCopilotStatusToAnthropic(status: number): number {
  // Most status codes map directly; special cases:
  // Copilot 422 (Unprocessable Entity) → 400 (Bad Request) for Anthropic
  if (status === 422) return 400
  // 529 (overloaded) → 529 (Anthropic also uses 529 for overloaded)
  return status
}

/**
 * Estimate token count from an Anthropic messages payload.
 * Uses a rough heuristic of ~4 characters per token (typical for English text
 * with code). This doesn't need to be exact — Claude Code uses it to decide
 * when to proactively trigger compaction, so a reasonable estimate is sufficient.
 */
function estimateTokenCount(payload: AnthropicMessagesPayload): number {
  let charCount = 0

  // Count system prompt
  if (typeof payload.system === "string") {
    charCount += payload.system.length
  } else if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      charCount += block.text.length
    }
  }

  // Count messages
  for (const message of payload.messages) {
    if (typeof message.content === "string") {
      charCount += message.content.length
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            charCount += block.text.length
            break
          case "thinking":
            charCount += block.thinking.length
            break
          case "tool_use":
            charCount += block.name.length + JSON.stringify(block.input).length
            break
          case "tool_result":
            charCount += typeof block.content === "string" ? block.content.length : 0
            break
          case "image":
            // Images are expensive — estimate ~1000 tokens for a typical image
            charCount += 4000
            break
        }
      }
    }
  }

  // Count tool definitions
  if (payload.tools) {
    for (const tool of payload.tools) {
      charCount += tool.name.length + (tool.description?.length ?? 0)
      charCount += JSON.stringify(tool.input_schema).length
    }
  }

  // ~4 chars per token is a reasonable heuristic for mixed English + code
  return Math.max(1, Math.ceil(charCount / 4))
}
