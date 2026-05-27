import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  translateToOpenAI,
  translateToAnthropic,
  mapOpenAIStopReasonToAnthropic,
  translateOpenAIErrorToAnthropic,
} from "../src/translate.ts"
import type {
  AnthropicMessagesPayload,
  ChatCompletionResponse,
} from "../src/types.ts"

describe("translateToOpenAI", () => {
  it("translates simple text message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.model, "claude-sonnet-4")
    assert.equal(result.max_tokens, 100)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].role, "user")
    assert.equal(result.messages[0].content, "hello")
  })

  it("translates system prompt string", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      system: "You are helpful",
      messages: [{ role: "user", content: "hi" }],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[0].role, "system")
    assert.equal(result.messages[0].content, "You are helpful")
  })

  it("translates system prompt array", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      system: [
        { type: "text", text: "Part A" },
        { type: "text", text: "Part B" },
      ],
      messages: [{ role: "user", content: "hi" }],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.messages[0].role, "system")
    assert.equal(result.messages[0].content, "Part A\n\nPart B")
  })

  it("normalizes claude-sonnet-4-* model names", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.model, "claude-sonnet-4")
  })

  it("normalizes claude-opus-4-* model names", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.model, "claude-opus-4")
  })

  it("preserves non-claude model names", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-4.1",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.model, "gpt-4.1")
  })

  it("translates tool_result blocks to tool role messages", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "result text",
            },
          ],
        },
      ],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.messages[0].role, "tool")
    assert.equal(result.messages[0].tool_call_id, "tool_1")
    assert.equal(result.messages[0].content, "result text")
  })

  it("translates assistant tool_use to tool_calls", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "read_file",
              input: { path: "/tmp/test.txt" },
            },
          ],
        },
      ],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.messages[0].role, "assistant")
    assert.ok(result.messages[0].tool_calls)
    assert.equal(result.messages[0].tool_calls![0].id, "call_1")
    assert.equal(result.messages[0].tool_calls![0].function.name, "read_file")
    assert.equal(
      result.messages[0].tool_calls![0].function.arguments,
      '{"path":"/tmp/test.txt"}',
    )
  })

  it("translates image blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc123",
              },
            },
          ],
        },
      ],
    }
    const result = translateToOpenAI(payload)
    const content = result.messages[0].content as Array<{
      type: string
      text?: string
      image_url?: { url: string }
    }>
    assert.ok(Array.isArray(content))
    assert.equal(content[0].type, "text")
    assert.equal(content[0].text, "describe this")
    assert.equal(content[1].type, "image_url")
    assert.equal(content[1].image_url!.url, "data:image/png;base64,abc123")
  })

  it("merges thinking blocks into text", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "thinking", thinking: "reasoning here" },
          ],
        },
      ],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.messages[0].content, "answer\n\nreasoning here")
  })

  it("translates tool_choice auto", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "auto" },
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.tool_choice, "auto")
  })

  it("translates tool_choice any to required", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" },
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.tool_choice, "required")
  })

  it("translates tool_choice none", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "none" },
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.tool_choice, "none")
  })

  it("translates tool_choice tool with name", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "tool", name: "read_file" },
    }
    const result = translateToOpenAI(payload)
    assert.deepEqual(result.tool_choice, {
      type: "function",
      function: { name: "read_file" },
    })
  })

  it("translates tools", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    }
    const result = translateToOpenAI(payload)
    assert.ok(result.tools)
    assert.equal(result.tools![0].type, "function")
    assert.equal(result.tools![0].function.name, "read_file")
    assert.equal(result.tools![0].function.description, "Read a file")
  })

  it("splits mixed tool_result and text in user message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "result" },
            { type: "text", text: "also this" },
          ],
        },
      ],
    }
    const result = translateToOpenAI(payload)
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[0].role, "tool")
    assert.equal(result.messages[1].role, "user")
    assert.equal(result.messages[1].content, "also this")
  })
})

describe("translateToAnthropic", () => {
  it("translates simple text response", () => {
    const response: ChatCompletionResponse = {
      id: "resp-1",
      object: "chat.completion",
      created: 1000,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    }
    const result = translateToAnthropic(response)
    assert.equal(result.id, "resp-1")
    assert.equal(result.type, "message")
    assert.equal(result.role, "assistant")
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, "text")
    assert.equal((result.content[0] as { type: "text"; text: string }).text, "hello")
    assert.equal(result.stop_reason, "end_turn")
  })

  it("translates tool calls response", () => {
    const response: ChatCompletionResponse = {
      id: "resp-2",
      object: "chat.completion",
      created: 1000,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"/test"}' },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        },
      ],
    }
    const result = translateToAnthropic(response)
    assert.equal(result.stop_reason, "tool_use")
    const toolBlock = result.content.find((b) => b.type === "tool_use")
    assert.ok(toolBlock)
    assert.equal(toolBlock.type, "tool_use")
    if (toolBlock.type === "tool_use") {
      assert.equal(toolBlock.id, "call_1")
      assert.equal(toolBlock.name, "read_file")
      assert.deepEqual(toolBlock.input, { path: "/test" })
    }
  })

  it("maps usage with cached tokens", () => {
    const response: ChatCompletionResponse = {
      id: "resp-3",
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
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    }
    const result = translateToAnthropic(response)
    assert.equal(result.usage.input_tokens, 60)
    assert.equal(result.usage.output_tokens, 10)
    assert.equal(result.usage.cache_read_input_tokens, 40)
  })
})

describe("mapOpenAIStopReasonToAnthropic", () => {
  it("maps stop to end_turn", () => {
    assert.equal(mapOpenAIStopReasonToAnthropic("stop"), "end_turn")
  })

  it("maps length to max_tokens", () => {
    assert.equal(mapOpenAIStopReasonToAnthropic("length"), "max_tokens")
  })

  it("maps tool_calls to tool_use", () => {
    assert.equal(mapOpenAIStopReasonToAnthropic("tool_calls"), "tool_use")
  })

  it("maps content_filter to end_turn", () => {
    assert.equal(mapOpenAIStopReasonToAnthropic("content_filter"), "end_turn")
  })

  it("maps null to null", () => {
    assert.equal(mapOpenAIStopReasonToAnthropic(null), null)
  })
})

describe("translateOpenAIErrorToAnthropic", () => {
  it("maps context_length_exceeded code to invalid_request_error", () => {
    const body = JSON.stringify({
      error: {
        message: "This model's maximum context length is 128000 tokens",
        code: "context_length_exceeded",
      },
    })
    const result = translateOpenAIErrorToAnthropic(400, body)
    assert.equal(result.type, "invalid_request_error")
    assert.ok(result.message.includes("context length"))
  })

  it("maps context length message to invalid_request_error even without code", () => {
    const body = JSON.stringify({
      error: {
        message: "Request too many tokens, reduce the length of messages",
      },
    })
    const result = translateOpenAIErrorToAnthropic(400, body)
    assert.equal(result.type, "invalid_request_error")
  })

  it("maps 429 to rate_limit_error", () => {
    const body = JSON.stringify({
      error: { message: "Rate limit exceeded", type: "rate_limit" },
    })
    const result = translateOpenAIErrorToAnthropic(429, body)
    assert.equal(result.type, "rate_limit_error")
  })

  it("maps 401 to authentication_error", () => {
    const body = JSON.stringify({
      error: { message: "Invalid token" },
    })
    const result = translateOpenAIErrorToAnthropic(401, body)
    assert.equal(result.type, "authentication_error")
  })

  it("maps 403 to permission_error", () => {
    const result = translateOpenAIErrorToAnthropic(403, '{"error":{"message":"forbidden"}}')
    assert.equal(result.type, "permission_error")
  })

  it("maps 404 to not_found_error", () => {
    const result = translateOpenAIErrorToAnthropic(404, '{"error":{"message":"not found"}}')
    assert.equal(result.type, "not_found_error")
  })

  it("maps 503 to overloaded_error", () => {
    const result = translateOpenAIErrorToAnthropic(503, '{"error":{"message":"unavailable"}}')
    assert.equal(result.type, "overloaded_error")
  })

  it("maps 529 to overloaded_error", () => {
    const result = translateOpenAIErrorToAnthropic(529, '{"error":{"message":"overloaded"}}')
    assert.equal(result.type, "overloaded_error")
  })

  it("maps 500 to api_error", () => {
    const result = translateOpenAIErrorToAnthropic(500, '{"error":{"message":"internal error"}}')
    assert.equal(result.type, "api_error")
  })

  it("handles non-JSON error body", () => {
    const result = translateOpenAIErrorToAnthropic(400, "Bad Request")
    assert.equal(result.type, "invalid_request_error")
    assert.equal(result.message, "Bad Request")
  })

  it("extracts message from nested error object", () => {
    const body = JSON.stringify({
      error: { message: "Something went wrong", code: "server_error" },
    })
    const result = translateOpenAIErrorToAnthropic(500, body)
    assert.equal(result.message, "Something went wrong")
  })

  it("detects token limit in message text", () => {
    const body = JSON.stringify({
      error: { message: "too many tokens in the request" },
    })
    const result = translateOpenAIErrorToAnthropic(400, body)
    assert.equal(result.type, "invalid_request_error")
  })
})
