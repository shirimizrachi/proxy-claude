import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from "../src/translate-stream.ts"
import type { AnthropicStreamState, ChatCompletionChunk } from "../src/types.ts"

function makeState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
}

function makeChunk(overrides: Partial<ChatCompletionChunk> & { delta?: ChatCompletionChunk["choices"][0]["delta"]; finish_reason?: ChatCompletionChunk["choices"][0]["finish_reason"] }): ChatCompletionChunk {
  const { delta, finish_reason, ...rest } = overrides
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 1000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        delta: delta ?? {},
        finish_reason: finish_reason ?? null,
        logprobs: null,
      },
    ],
    ...rest,
  }
}

describe("translateChunkToAnthropicEvents", () => {
  it("emits message_start on first chunk", () => {
    const state = makeState()
    const chunk = makeChunk({ delta: { content: "hi" } })
    const events = translateChunkToAnthropicEvents(chunk, state)

    assert.ok(events.length >= 1)
    assert.equal(events[0].type, "message_start")
    assert.ok(state.messageStartSent)
  })

  it("emits content_block_start and delta for text", () => {
    const state = makeState()
    const chunk = makeChunk({ delta: { content: "hello" } })
    const events = translateChunkToAnthropicEvents(chunk, state)

    const start = events.find((e) => e.type === "content_block_start")
    assert.ok(start)
    if (start?.type === "content_block_start") {
      assert.equal(start.content_block.type, "text")
    }

    const delta = events.find((e) => e.type === "content_block_delta")
    assert.ok(delta)
    if (delta?.type === "content_block_delta") {
      assert.equal(delta.delta.type, "text_delta")
      if (delta.delta.type === "text_delta") {
        assert.equal(delta.delta.text, "hello")
      }
    }
  })

  it("does not re-emit content_block_start for subsequent text chunks", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(makeChunk({ delta: { content: "a" } }), state)

    const events2 = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "b" } }),
      state,
    )

    const starts = events2.filter((e) => e.type === "content_block_start")
    assert.equal(starts.length, 0)

    const deltas = events2.filter((e) => e.type === "content_block_delta")
    assert.equal(deltas.length, 1)
  })

  it("emits tool_use blocks for tool calls", () => {
    const state = makeState()
    const chunk = makeChunk({
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"pa' },
          },
        ],
      },
    })
    const events = translateChunkToAnthropicEvents(chunk, state)

    const toolStart = events.find(
      (e) => e.type === "content_block_start" && e.content_block.type === "tool_use",
    )
    assert.ok(toolStart)

    const argsDelta = events.find(
      (e) =>
        e.type === "content_block_delta" &&
        e.delta.type === "input_json_delta",
    )
    assert.ok(argsDelta)
  })

  it("accumulates tool arguments across chunks", () => {
    const state = makeState()
    // First chunk: start tool
    translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"pa' },
            },
          ],
        },
      }),
      state,
    )

    // Second chunk: more arguments
    const events2 = translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: 'th":"/test"}' } },
          ],
        },
      }),
      state,
    )

    const argsDelta = events2.find(
      (e) =>
        e.type === "content_block_delta" &&
        e.delta.type === "input_json_delta",
    )
    assert.ok(argsDelta)
    if (argsDelta?.type === "content_block_delta" && argsDelta.delta.type === "input_json_delta") {
      assert.equal(argsDelta.delta.partial_json, 'th":"/test"}')
    }
  })

  it("closes text block before starting tool block", () => {
    const state = makeState()
    // First: text content
    translateChunkToAnthropicEvents(makeChunk({ delta: { content: "thinking..." } }), state)

    // Then: tool call
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "run", arguments: "{}" } },
          ],
        },
      }),
      state,
    )

    const stopEvents = events.filter((e) => e.type === "content_block_stop")
    assert.ok(stopEvents.length >= 1, "should close text block before tool")
  })

  it("emits message_delta and message_stop on finish_reason", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(makeChunk({ delta: { content: "hi" } }), state)

    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: {}, finish_reason: "stop" }),
      state,
    )

    const messageDelta = events.find((e) => e.type === "message_delta")
    assert.ok(messageDelta)
    if (messageDelta?.type === "message_delta") {
      assert.equal(messageDelta.delta.stop_reason, "end_turn")
    }

    const messageStop = events.find((e) => e.type === "message_stop")
    assert.ok(messageStop)
  })

  it("returns empty events for empty choices", () => {
    const state = makeState()
    const chunk: ChatCompletionChunk = {
      id: "chunk-1",
      object: "chat.completion.chunk",
      created: 1000,
      model: "claude-sonnet-4",
      choices: [],
    }
    const events = translateChunkToAnthropicEvents(chunk, state)
    assert.equal(events.length, 0)
  })
})

describe("translateErrorToAnthropicErrorEvent", () => {
  it("returns default api_error when called with no args", () => {
    const event = translateErrorToAnthropicErrorEvent()
    assert.equal(event.type, "error")
    if (event.type === "error") {
      assert.equal(event.error.type, "api_error")
      assert.equal(event.error.message, "An unexpected error occurred during streaming.")
    }
  })

  it("returns custom error type and message", () => {
    const event = translateErrorToAnthropicErrorEvent(
      "invalid_request_error",
      "Context length exceeded",
    )
    assert.equal(event.type, "error")
    if (event.type === "error") {
      assert.equal(event.error.type, "invalid_request_error")
      assert.equal(event.error.message, "Context length exceeded")
    }
  })

  it("uses default message when only type is provided", () => {
    const event = translateErrorToAnthropicErrorEvent("rate_limit_error")
    assert.equal(event.type, "error")
    if (event.type === "error") {
      assert.equal(event.error.type, "rate_limit_error")
      assert.equal(event.error.message, "An unexpected error occurred during streaming.")
    }
  })
})
