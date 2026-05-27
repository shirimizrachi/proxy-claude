import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

import { startServer } from "../src/server.ts"

const TEST_NONCE = "test-nonce-12345"
const TEST_TOKEN = "copilot-token-abc"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString()
        })
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: data }),
        )
      },
    )
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

function sseRequest(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; events: Array<{ type: string; data: string }> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let raw = ""
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString()
        })
        res.on("end", () => {
          const events: Array<{ type: string; data: string }> = []
          const parts = raw.split("\n\n").filter((p) => p.trim())
          for (const part of parts) {
            let type = ""
            let data = ""
            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) type = line.slice(7)
              if (line.startsWith("data: ")) data = line.slice(6)
            }
            if (type || data) events.push({ type, data })
          }
          resolve({ status: res.statusCode!, events })
        })
      },
    )
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

/** Start a minimal mock Copilot backend */
function startMockCopilot(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void,
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
      })
    })
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("proxy server", () => {
  const servers: http.Server[] = []

  afterEach(() => {
    for (const s of servers) {
      s.close()
    }
    servers.length = 0
  })

  async function setup(
    mockHandler?: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => void,
  ) {
    let mockUrl = "http://127.0.0.1:1" // unused fallback

    if (mockHandler) {
      const mock = await startMockCopilot(mockHandler)
      servers.push(mock.server)
      mockUrl = mock.url
    }

    const { server, port } = await startServer(
      0,
      TEST_NONCE,
      () => TEST_TOKEN,
      () => mockUrl,
    )
    servers.push(server)
    return { port, mockUrl }
  }

  // ── Health check ─────────────────────────────────────────────────────────

  it("responds to GET / with status ok", async () => {
    const { port } = await setup()
    const res = await request(port, "GET", "/")
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.status, "ok")
  })

  // ── Auth ─────────────────────────────────────────────────────────────────

  it("rejects request with wrong nonce", async () => {
    const { port } = await setup()
    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
      { "x-api-key": "wrong-nonce" },
    )
    assert.equal(res.status, 401)
  })

  it("accepts auth via x-api-key", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          id: "resp-1",
          object: "chat.completion",
          created: 1000,
          model: "claude-sonnet-4",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        }),
      )
    })

    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )
    assert.equal(res.status, 200)
  })

  it("accepts auth via Authorization Bearer", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          id: "resp-1",
          object: "chat.completion",
          created: 1000,
          model: "claude-sonnet-4",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        }),
      )
    })

    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
      { Authorization: `Bearer ${TEST_NONCE}` },
    )
    assert.equal(res.status, 200)
  })

  it("rejects request with no auth header", async () => {
    const { port } = await setup()
    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    assert.equal(res.status, 401)
  })

  // ── Non-streaming ────────────────────────────────────────────────────────

  it("translates non-streaming request/response", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          id: "resp-1",
          object: "chat.completion",
          created: 1000,
          model: "claude-sonnet-4",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello back!" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
      )
    })

    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    assert.equal(res.status, 200)
    assert.ok(res.headers["x-request-id"])

    const body = JSON.parse(res.body)
    assert.equal(body.type, "message")
    assert.equal(body.role, "assistant")
    assert.equal(body.stop_reason, "end_turn")
    assert.equal(body.content[0].type, "text")
    assert.equal(body.content[0].text, "Hello back!")
    assert.equal(body.usage.input_tokens, 10)
    assert.equal(body.usage.output_tokens, 5)
  })

  // ── Streaming ────────────────────────────────────────────────────────────

  it("translates streaming request into Anthropic SSE events", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      })
      // Simulate OpenAI SSE stream
      res.write(
        'data: {"id":"ch-1","object":"chat.completion.chunk","created":1000,"model":"claude-sonnet-4","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null,"logprobs":null}]}\n\n',
      )
      res.write(
        'data: {"id":"ch-1","object":"chat.completion.chunk","created":1000,"model":"claude-sonnet-4","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null,"logprobs":null}]}\n\n',
      )
      res.write(
        'data: {"id":"ch-1","object":"chat.completion.chunk","created":1000,"model":"claude-sonnet-4","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}\n\n',
      )
      res.write("data: [DONE]\n\n")
      res.end()
    })

    const { status, events } = await sseRequest(
      port,
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    assert.equal(status, 200)

    const types = events.map((e) => e.type)
    assert.ok(types.includes("message_start"), "should have message_start")
    assert.ok(
      types.includes("content_block_start"),
      "should have content_block_start",
    )
    assert.ok(
      types.includes("content_block_delta"),
      "should have content_block_delta",
    )
    assert.ok(
      types.includes("content_block_stop"),
      "should have content_block_stop",
    )
    assert.ok(types.includes("message_delta"), "should have message_delta")
    assert.ok(types.includes("message_stop"), "should have message_stop")

    // Verify text delta content
    const textDeltas = events.filter((e) => {
      if (!e.data) return false
      try {
        const parsed = JSON.parse(e.data)
        return (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta"
        )
      } catch {
        return false
      }
    })
    assert.ok(textDeltas.length >= 1)
  })

  // ── Count tokens ─────────────────────────────────────────────────────────

  it("estimates token count from payload", async () => {
    const { port } = await setup()

    const res = await request(
      port,
      "POST",
      "/v1/messages/count_tokens",
      JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    // "hello" = 5 chars, ~4 chars/token → ceil(5/4) = 2
    assert.ok(body.input_tokens > 0, "token count should be positive")
    assert.equal(typeof body.input_tokens, "number")
  })

  it("returns higher token count for longer messages", async () => {
    const { port } = await setup()

    const shortRes = await request(
      port,
      "POST",
      "/v1/messages/count_tokens",
      JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    const longContent = "This is a much longer message with many more tokens that should result in a significantly higher count."
    const longRes = await request(
      port,
      "POST",
      "/v1/messages/count_tokens",
      JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: longContent }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    const shortBody = JSON.parse(shortRes.body)
    const longBody = JSON.parse(longRes.body)
    assert.ok(longBody.input_tokens > shortBody.input_tokens,
      `longer message (${longBody.input_tokens}) should have more tokens than shorter (${shortBody.input_tokens})`)
  })

  it("counts system prompt in token estimate", async () => {
    const { port } = await setup()

    const noSystemRes = await request(
      port,
      "POST",
      "/v1/messages/count_tokens",
      JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    const withSystemRes = await request(
      port,
      "POST",
      "/v1/messages/count_tokens",
      JSON.stringify({
        model: "claude-sonnet-4",
        system: "You are a helpful assistant with extensive knowledge.",
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    const noSys = JSON.parse(noSystemRes.body)
    const withSys = JSON.parse(withSystemRes.body)
    assert.ok(withSys.input_tokens > noSys.input_tokens,
      "adding system prompt should increase token count")
  })

  it("rejects count_tokens without auth", async () => {
    const { port } = await setup()
    const res = await request(
      port,
      "POST",
      "/v1/messages/count_tokens",
      JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
      { "x-api-key": "bad" },
    )
    assert.equal(res.status, 401)
  })

  // ── Models endpoint ───────────────────────────────────────────────────────

  it("returns model list for GET /v1/models", async () => {
    const { port } = await setup()
    const res = await request(port, "GET", "/v1/models", undefined, {
      "x-api-key": TEST_NONCE,
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.object, "list")
    assert.ok(Array.isArray(body.data))
    assert.ok(body.data.length > 0)
    assert.equal(body.data[0].object, "model")
  })

  it("returns single model for GET /v1/models/:id", async () => {
    const { port } = await setup()
    const res = await request(port, "GET", "/v1/models/claude-sonnet-4", undefined, {
      "x-api-key": TEST_NONCE,
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.id, "claude-sonnet-4")
    assert.equal(body.object, "model")
  })

  it("rejects /v1/models without auth", async () => {
    const { port } = await setup()
    const res = await request(port, "GET", "/v1/models")
    assert.equal(res.status, 401)
  })

  // ── Query string handling (SDK sends ?beta=true) ─────────────────────────

  it("routes /v1/messages?beta=true to messages handler", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          id: "resp-1",
          object: "chat.completion",
          created: 1000,
          model: "claude-sonnet-4",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        }),
      )
    })

    const res = await request(
      port,
      "POST",
      "/v1/messages?beta=true",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
      { "x-api-key": TEST_NONCE },
    )
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.type, "message")
  })

  it("routes /v1/messages/count_tokens?beta=true to count_tokens handler", async () => {
    const { port } = await setup()
    const res = await request(
      port,
      "POST",
      "/v1/messages/count_tokens?beta=true",
      JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.input_tokens > 0, "token count should be positive")
  })

  it("routes /v1/messages/batches?beta=true to batches handler", async () => {
    const { port } = await setup()
    const res = await request(
      port,
      "POST",
      "/v1/messages/batches?beta=true",
      JSON.stringify({ requests: [] }),
      { "x-api-key": TEST_NONCE },
    )
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.object, "list")
  })

  it("routes /v1/models?beta=true to models handler", async () => {
    const { port } = await setup()
    const res = await request(port, "GET", "/v1/models?beta=true", undefined, {
      "x-api-key": TEST_NONCE,
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.object, "list")
  })

  // ── 404 ──────────────────────────────────────────────────────────────────

  it("returns 404 for unknown routes", async () => {
    const { port } = await setup()
    const res = await request(port, "GET", "/v1/unknown")
    assert.equal(res.status, 404)
    const body = JSON.parse(res.body)
    assert.equal(body.error.type, "not_found_error")
  })

  it("returns 404 for POST to root", async () => {
    const { port } = await setup()
    const res = await request(port, "POST", "/", "{}")
    assert.equal(res.status, 404)
  })

  // ── Copilot error forwarding ─────────────────────────────────────────────

  it("forwards Copilot API errors in Anthropic format", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }))
    })

    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    assert.equal(res.status, 429)
    const body = JSON.parse(res.body)
    assert.equal(body.type, "error")
    assert.equal(body.error.type, "rate_limit_error")
  })

  it("translates context_length_exceeded to invalid_request_error", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        error: {
          message: "This model's maximum context length is 128000 tokens",
          code: "context_length_exceeded",
        },
      }))
    })

    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    assert.equal(res.status, 400)
    const body = JSON.parse(res.body)
    assert.equal(body.type, "error")
    assert.equal(body.error.type, "invalid_request_error")
    assert.ok(body.error.message.includes("context length"))
  })

  it("translates 503 errors to overloaded_error", async () => {
    const { port } = await setup((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }))
    })

    const res = await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    assert.equal(res.status, 503)
    const body = JSON.parse(res.body)
    assert.equal(body.type, "error")
    assert.equal(body.error.type, "overloaded_error")
  })

  // ── Request translation verification ─────────────────────────────────────

  it("sends translated OpenAI payload to Copilot backend", async () => {
    let receivedBody = ""
    let receivedHeaders: http.IncomingHttpHeaders = {}

    const { port } = await setup((req, res) => {
      receivedHeaders = req.headers
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        receivedBody = body
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            id: "resp-1",
            object: "chat.completion",
            created: 1000,
            model: "claude-sonnet-4",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
          }),
        )
      })
    })

    await request(
      port,
      "POST",
      "/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 50,
        system: "Be brief",
        messages: [{ role: "user", content: "What is 2+2?" }],
      }),
      { "x-api-key": TEST_NONCE },
    )

    const parsed = JSON.parse(receivedBody)
    assert.equal(parsed.model, "claude-sonnet-4")
    assert.equal(parsed.max_tokens, 50)
    // System prompt should be first message
    assert.equal(parsed.messages[0].role, "system")
    assert.equal(parsed.messages[0].content, "Be brief")
    // User message should follow
    assert.equal(parsed.messages[1].role, "user")
    assert.equal(parsed.messages[1].content, "What is 2+2?")

    // Verify authorization header forwarded
    assert.ok(receivedHeaders.authorization?.startsWith("Bearer "))
  })
})
