import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  clampEffort,
  applyEffortFloor,
  ghcpIdToAlias,
  translateToOpenAI,
  translateToAnthropic,
  mapOpenAIStopReasonToAnthropic,
  translateOpenAIErrorToAnthropic,
  mapModelToCopilot,
} from "../src/translate.ts"
import type {
  AnthropicMessagesPayload,
  ChatCompletionResponse,
  ModelSupports,
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

  it("normalizes claude-sonnet-4-* model names with modelConfig", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }
    const result = translateToOpenAI(payload, {
      primary: "claude-opus-4.7",
      sonnet: "claude-sonnet-4.6",
      haiku: "claude-haiku-4.5",
      smallFast: "claude-haiku-4.5",
    })
    assert.equal(result.model, "claude-sonnet-4.6")
  })

  it("normalizes claude-opus-4-* model names with modelConfig", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }
    const result = translateToOpenAI(payload, {
      primary: "claude-opus-4.7",
      sonnet: "claude-opus-4.7",
      haiku: "claude-haiku-4.5",
      smallFast: "claude-haiku-4.5",
    })
    assert.equal(result.model, "claude-opus-4.7")
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

describe("mapModelToCopilot", () => {
  const cfg = {
    primary: "claude-opus-4.7-1m-internal[1m]",
    sonnet: "claude-sonnet-4.6",
    haiku: "claude-haiku-4.5",
    smallFast: "claude-haiku-4.5",
  }

  it("maps tier alias 'haiku' to smallFast", () => {
    assert.equal(mapModelToCopilot("haiku", cfg), "claude-haiku-4.5")
  })

  it("maps tier alias 'sonnet' to sonnet", () => {
    assert.equal(mapModelToCopilot("sonnet", cfg), "claude-sonnet-4.6")
  })

  it("maps tier alias 'opus' to primary", () => {
    assert.equal(mapModelToCopilot("opus", cfg), "claude-opus-4.7-1m-internal")
  })

  it("maps canonical haiku ids to smallFast", () => {
    assert.equal(mapModelToCopilot("claude-3-5-haiku-20241022", cfg), "claude-haiku-4.5")
    assert.equal(mapModelToCopilot("claude-haiku-4-5-20251213", cfg), "claude-haiku-4.5")
  })

  it("maps canonical sonnet ids to sonnet", () => {
    assert.equal(mapModelToCopilot("claude-3-5-sonnet-20241022", cfg), "claude-sonnet-4.6")
    assert.equal(mapModelToCopilot("claude-sonnet-4-5-20250929", cfg), "claude-sonnet-4.6")
  })

  it("maps canonical opus ids to primary", () => {
    assert.equal(mapModelToCopilot("claude-opus-4-6", cfg), "claude-opus-4.7-1m-internal")
  })

  it("strips only literal [1m] suffix, preserves inner 1m", () => {
    assert.equal(
      mapModelToCopilot("claude-opus-4.7-1m-internal[1m]", cfg),
      "claude-opus-4.7-1m-internal",
    )
  })

  it("passes non-claude models through unchanged", () => {
    assert.equal(mapModelToCopilot("gpt-4.1", cfg), "gpt-4.1")
    assert.equal(mapModelToCopilot("gemini-2.5-pro", cfg), "gemini-2.5-pro")
  })

  it("falls back to primary for every tier when only primary is configured", () => {
    const c = {
      primary: "claude-opus-4.7",
      sonnet: "claude-opus-4.7",
      haiku: "claude-opus-4.7",
      smallFast: "claude-opus-4.7",
    }
    assert.equal(mapModelToCopilot("haiku", c), "claude-opus-4.7")
    assert.equal(mapModelToCopilot("sonnet", c), "claude-opus-4.7")
    assert.equal(mapModelToCopilot("opus", c), "claude-opus-4.7")
    assert.equal(mapModelToCopilot("claude-3-5-haiku-20241022", c), "claude-opus-4.7")
    assert.equal(mapModelToCopilot("claude-3-5-sonnet-20241022", c), "claude-opus-4.7")
  })

  it("returns input unchanged when no modelConfig provided", () => {
    assert.equal(mapModelToCopilot("haiku"), "haiku")
    assert.equal(mapModelToCopilot("claude-opus-4.7-1m-internal[1m]"), "claude-opus-4.7-1m-internal")
  })

  it("translateToOpenAI applies mapping via modelConfig", () => {
    const result = translateToOpenAI(
      { model: "haiku", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      cfg,
    )
    assert.equal(result.model, "claude-haiku-4.5")
  })
})

describe("clampEffort", () => {
  it("passes through when requested is in supported set", () => {
    assert.equal(clampEffort("medium", ["low", "medium", "high"]), "medium")
    assert.equal(clampEffort("xhigh", ["low", "medium", "high", "xhigh"]), "xhigh")
  })

  it("clamps down to highest supported when requested is above all", () => {
    // Claude Code's "max" on a model whose ceiling is "high"
    assert.equal(clampEffort("max", ["low", "medium", "high"]), "high")
  })

  it("clamps down to xhigh when supported includes xhigh", () => {
    assert.equal(clampEffort("max", ["low", "medium", "high", "xhigh"]), "xhigh")
  })

  it("clamps up to lowest supported when requested is below all", () => {
    assert.equal(clampEffort("minimal", ["low", "medium", "high"]), "low")
  })

  it("on a middle gap, picks nearest preferring lower", () => {
    // supported = [low, high], requested = medium → low (safer / cheaper)
    assert.equal(clampEffort("medium", ["low", "high"]), "low")
    // supported = [low, high], requested = high → high (passthrough)
    assert.equal(clampEffort("high", ["low", "high"]), "high")
  })

  it("returns undefined when supported is empty or missing", () => {
    assert.equal(clampEffort("high", []), undefined)
    assert.equal(clampEffort("high", undefined), undefined)
  })

  it("returns undefined when requested is missing", () => {
    assert.equal(clampEffort(undefined, ["low", "high"]), undefined)
  })

  it("returns undefined for an unknown requested level", () => {
    assert.equal(clampEffort("ultra", ["low", "high"]), undefined)
  })

  it("ignores unknown levels in the supported set", () => {
    // "weird" is filtered out of the supported set; only "high" remains. "medium"
    // is below the only valid supported entry, so we clamp up to "high".
    assert.equal(clampEffort("medium", ["weird", "high"]), "high")
  })

  it("returns undefined when the supported set has only unknown levels", () => {
    assert.equal(clampEffort("medium", ["weird", "alsoweird"]), undefined)
  })
})

describe("translateToOpenAI effort passthrough", () => {
  it("omits reasoning_effort when no output_config is present", () => {
    const result = translateToOpenAI(
      { model: "claude-sonnet-4.6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      undefined,
      { reasoning_effort: ["low", "medium", "high"] },
    )
    assert.equal(result.reasoning_effort, undefined)
  })

  it("forwards effort verbatim when the mapped model supports it", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "medium" },
    }
    const result = translateToOpenAI(payload, undefined, {
      reasoning_effort: ["low", "medium", "high"],
    })
    assert.equal(result.reasoning_effort, "medium")
  })

  it("clamps effort to the mapped model's ceiling", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    }
    const result = translateToOpenAI(payload, undefined, {
      reasoning_effort: ["low", "medium", "high"],
    })
    assert.equal(result.reasoning_effort, "high")
  })

  it("drops effort silently when no capabilities are provided", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    }
    const result = translateToOpenAI(payload, undefined, undefined)
    assert.equal(result.reasoning_effort, undefined)
  })

  it("uses capabilities of the MAPPED model id (not the incoming tier name)", () => {
    // Incoming tier "sonnet" gets mapped via modelConfig to a GHCP id. The
    // capability lookup at the call site must be done against the mapped id —
    // here we simulate the same contract by passing capabilities for the
    // mapped model only.
    const cfg = {
      primary: "claude-opus-4.6",
      sonnet: "claude-sonnet-4.6",
      haiku: "claude-haiku-4.5",
      smallFast: "claude-haiku-4.5",
    }
    const sonnetCaps: ModelSupports = { reasoning_effort: ["low", "medium", "high"] }
    const payload: AnthropicMessagesPayload = {
      model: "sonnet",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    }
    // mapModelToCopilot("sonnet", cfg) === "claude-sonnet-4.6"; caller passes
    // the capabilities for that mapped id.
    const result = translateToOpenAI(payload, cfg, sonnetCaps)
    assert.equal(result.model, "claude-sonnet-4.6")
    assert.equal(result.reasoning_effort, "high")
  })

  it("drops effort when the model exposes no reasoning_effort capability", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" },
    }
    const result = translateToOpenAI(payload, undefined, {
      tool_calls: true,
      streaming: true,
    })
    assert.equal(result.reasoning_effort, undefined)
  })
})

describe("applyEffortFloor", () => {
  it("raises low to max when floor is max", () => {
    assert.equal(applyEffortFloor("low", "max"), "max")
  })

  it("raises medium to max when floor is max", () => {
    assert.equal(applyEffortFloor("medium", "max"), "max")
  })

  it("raises high to max when floor is max", () => {
    assert.equal(applyEffortFloor("high", "max"), "max")
  })

  it("does not lower when request is already at or above floor", () => {
    assert.equal(applyEffortFloor("max", "high"), "max")
    assert.equal(applyEffortFloor("high", "high"), "high")
    assert.equal(applyEffortFloor("xhigh", "high"), "xhigh")
  })

  it("uses floor when requested is undefined", () => {
    assert.equal(applyEffortFloor(undefined, "max"), "max")
    assert.equal(applyEffortFloor(undefined, "high"), "high")
  })

  it("passes through when floor is undefined", () => {
    assert.equal(applyEffortFloor("low", undefined), "low")
    assert.equal(applyEffortFloor("high", undefined), "high")
    assert.equal(applyEffortFloor(undefined, undefined), undefined)
  })

  it("ignores invalid floor values", () => {
    assert.equal(applyEffortFloor("low", "ultra"), "low")
    assert.equal(applyEffortFloor("high", "banana"), "high")
  })

  it("uses floor when requested is unrecognized", () => {
    assert.equal(applyEffortFloor("ultra", "max"), "max")
    assert.equal(applyEffortFloor("banana", "high"), "high")
  })
})

describe("trailing whitespace on final assistant message (GHCP opus-4.8 fix)", () => {
  it("right-trims trailing whitespace from final assistant string content", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello there!  \n  " },
      ],
    })
    // ensureConversationEndsWithUser appends a synthetic user message after
    // the assistant, so the trimmed assistant is now second-to-last.
    const assistantMsg = result.messages[result.messages.length - 2]
    assert.equal(assistantMsg.role, "assistant")
    assert.equal(assistantMsg.content, "Hello there!")
  })

  it("does not modify a final user message", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "trailing spaces here   " },
      ],
    })
    const last = result.messages[result.messages.length - 1]
    assert.equal(last.role, "user")
    assert.equal(last.content, "trailing spaces here   ")
  })

  it("only trims the LAST assistant message, not earlier ones", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "answer 1   " }, // not last → keep
        { role: "user", content: "q2" },
        { role: "assistant", content: "answer 2   " }, // last → trim
      ],
    })
    // No system message, so indices match input directly.
    assert.equal(result.messages[1].content, "answer 1   ")
    assert.equal(result.messages[3].content, "answer 2")
  })

  it("handles trailing whitespace inside array content (multi-modal)", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] },
        { role: "assistant", content: [{ type: "text", text: "I see an image.  \n" }] },
      ],
    })
    // ensureConversationEndsWithUser appends a synthetic user message, so the
    // assistant whose trailing whitespace we trimmed is second-to-last.
    const assistantMsg = result.messages[result.messages.length - 2]
    assert.equal(assistantMsg.role, "assistant")
    // The content might be normalized to string or stay as array — check both paths
    if (typeof assistantMsg.content === "string") {
      assert.match(assistantMsg.content, /image\.$/, "should not end with whitespace")
    } else if (Array.isArray(assistantMsg.content)) {
      const lastText = [...assistantMsg.content].reverse().find((p) => p.type === "text")
      assert.ok(lastText && lastText.type === "text")
      assert.equal(lastText.text.endsWith(" "), false)
    }
  })

  it("leaves empty content alone (no infinite trim)", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "" },
      ],
    })
    assert.equal(result.messages[1].content, "")
  })

  it("nulls out empty content when tool_calls are present (OpenAI convention)", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "use the tool" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "   " },
            { type: "tool_use", id: "t1", name: "calc", input: { a: 1 } },
          ],
        },
      ],
    })
    // ensureConversationEndsWithUser appends a synthetic user message; the
    // trimmed assistant with tool_calls is now second-to-last.
    const assistantMsg = result.messages[result.messages.length - 2]
    assert.equal(assistantMsg.role, "assistant")
    // Text was just whitespace; after trim it becomes empty → null with tool_calls
    assert.equal(assistantMsg.content, null)
    assert.ok(assistantMsg.tool_calls && assistantMsg.tool_calls.length === 1)
  })
})

describe("ensureConversationEndsWithUser (GHCP opus-4.8 prefill fix)", () => {
  it("appends a synthetic user message when the conversation ends with an assistant message", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello!" },
      ],
    })
    // Last message must be a user message
    const last = result.messages[result.messages.length - 1]
    assert.equal(last.role, "user")
    // Previous assistant message should still be present and intact
    assert.equal(result.messages[result.messages.length - 2].role, "assistant")
    assert.equal(result.messages[result.messages.length - 2].content, "Hello!")
  })

  it("appends synthetic user message after assistant tool_use ending", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "use a tool" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me try." },
            { type: "tool_use", id: "t1", name: "calc", input: { a: 1 } },
          ],
        },
      ],
    })
    const last = result.messages[result.messages.length - 1]
    assert.equal(last.role, "user")
  })

  it("does NOT append a synthetic user message when conversation already ends with a user message", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "follow-up" },
      ],
    })
    assert.equal(result.messages.length, 3)
    const last = result.messages[result.messages.length - 1]
    assert.equal(last.role, "user")
    assert.equal(last.content, "follow-up")
  })

  it("does NOT append a synthetic user message when conversation ends with a tool message (tool_result)", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "use the tool" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me try." },
            { type: "tool_use", id: "t1", name: "calc", input: { a: 1 } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "42" },
          ],
        },
      ],
    })
    // Last message must NOT be a synthetic "Please continue." user message;
    // the tool message is a valid terminator for OpenAI/GHCP.
    const last = result.messages[result.messages.length - 1]
    assert.equal(last.role, "tool")
  })

  it("appends user message after trimming trailing whitespace on the assistant message", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello!   \n  " },
      ],
    })
    // Trim still applies to the second-to-last (assistant) message
    const prev = result.messages[result.messages.length - 2]
    assert.equal(prev.role, "assistant")
    assert.equal(prev.content, "Hello!")
    // And the appended user message is the new last message
    const last = result.messages[result.messages.length - 1]
    assert.equal(last.role, "user")
  })
})

describe("ghcpIdToAlias", () => {
  it("aliases dot-versioned opus 1m-internal id", () => {
    assert.deepEqual(ghcpIdToAlias("claude-opus-4.7-1m-internal"), {
      alias: "claude-opus-4-7",
      has1m: true,
    })
  })

  it("aliases dot-versioned opus 1m id without -internal", () => {
    assert.deepEqual(ghcpIdToAlias("claude-opus-4.6-1m"), {
      alias: "claude-opus-4-6",
      has1m: true,
    })
  })

  it("aliases plain dot-versioned opus id without 1m", () => {
    assert.deepEqual(ghcpIdToAlias("claude-opus-4.6"), {
      alias: "claude-opus-4-6",
      has1m: false,
    })
  })

  it("aliases sonnet and haiku dot-versioned ids", () => {
    assert.deepEqual(ghcpIdToAlias("claude-sonnet-4.6"), {
      alias: "claude-sonnet-4-6",
      has1m: false,
    })
    assert.deepEqual(ghcpIdToAlias("claude-haiku-4.5"), {
      alias: "claude-haiku-4-5",
      has1m: false,
    })
  })

  it("returns null for non-claude ids", () => {
    assert.equal(ghcpIdToAlias("gpt-4.1"), null)
    assert.equal(ghcpIdToAlias("o4-mini"), null)
  })

  it("returns null for already-canonical claude ids (no dot in version)", () => {
    assert.equal(ghcpIdToAlias("claude-opus-4"), null)
    assert.equal(ghcpIdToAlias("claude-opus-4-6"), null)
    assert.equal(ghcpIdToAlias("claude-sonnet-4-5"), null)
  })

  it("is case-insensitive on family but normalizes to lowercase", () => {
    const result = ghcpIdToAlias("Claude-Opus-4.7-1m-internal")
    assert.equal(result?.alias, "claude-opus-4-7")
    assert.equal(result?.has1m, true)
  })

  it("does not pick up 1m from arbitrary substrings like 'opus-4.7-1minor'", () => {
    const result = ghcpIdToAlias("claude-opus-4.7-1minor")
    // 1minor → matches /(^|[-_.])1m([-_.]|$)/ ? "1minor" → starts at '1', next char is 'i' not separator → no match
    assert.equal(result?.has1m, false)
  })

  it("does pick up 1m when it's a distinct segment", () => {
    assert.equal(ghcpIdToAlias("claude-opus-4.7-internal-1m")?.has1m, true)
    assert.equal(ghcpIdToAlias("claude-opus-4.7-1m")?.has1m, true)
    assert.equal(ghcpIdToAlias("claude-opus-4.7-1m-foo")?.has1m, true)
  })
})

describe("mapModelToCopilot with alias resolution", () => {
  const cfg = {
    primary: "claude-opus-4-7[1m]",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    smallFast: "claude-haiku-4-5",
  }
  const resolveAlias = (alias: string): string | undefined => {
    const map: Record<string, string> = {
      "claude-opus-4-7": "claude-opus-4.7-1m-internal",
      "claude-sonnet-4-6": "claude-sonnet-4.6",
      "claude-haiku-4-5": "claude-haiku-4.5",
    }
    return map[alias]
  }

  it("resolves alias-with-[1m]-suffix to real GHCP id", () => {
    assert.equal(
      mapModelToCopilot("claude-opus-4-7[1m]", cfg, resolveAlias),
      "claude-opus-4.7-1m-internal",
    )
  })

  it("resolves tier name 'sonnet' to mapped alias then to real id", () => {
    assert.equal(
      mapModelToCopilot("sonnet", cfg, resolveAlias),
      "claude-sonnet-4.6",
    )
  })

  it("resolves tier name 'haiku' to mapped alias then to real id", () => {
    assert.equal(
      mapModelToCopilot("haiku", cfg, resolveAlias),
      "claude-haiku-4.5",
    )
  })

  it("resolves tier name 'opus' to primary alias then to real id", () => {
    assert.equal(
      mapModelToCopilot("opus", cfg, resolveAlias),
      "claude-opus-4.7-1m-internal",
    )
  })

  it("passes through unknown alias unchanged (no modelConfig, no tier fallback)", () => {
    // With no modelConfig, CLAUDE_RE doesn't get a chance to route to a tier,
    // so an unknown claude-shaped id falls through to alias resolution and
    // (alias miss) returns as-is.
    assert.equal(
      mapModelToCopilot("claude-opus-4-99", undefined, resolveAlias),
      "claude-opus-4-99",
    )
  })

  it("works without modelConfig (just alias resolution)", () => {
    assert.equal(
      mapModelToCopilot("claude-opus-4-7", undefined, resolveAlias),
      "claude-opus-4.7-1m-internal",
    )
  })

  it("works without resolveAlias (no-op alias step)", () => {
    assert.equal(
      mapModelToCopilot("claude-opus-4-7[1m]", cfg),
      "claude-opus-4-7", // [1m] stripped; no alias resolution; falls through CLAUDE_RE → modelConfig.primary → "claude-opus-4-7[1m]" → strip → "claude-opus-4-7"
    )
  })

  it("strips [1m] from tier-resolved value too", () => {
    // Even though cfg.primary has [1m], the final return strips it.
    assert.equal(
      mapModelToCopilot("opus", cfg, resolveAlias),
      "claude-opus-4.7-1m-internal",
    )
  })
})
