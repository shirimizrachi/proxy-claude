import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { parseSSE } from "../src/copilot.ts"

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
  })
}

describe("parseSSE", () => {
  it("parses a single event", async () => {
    const stream = makeStream(["data: {\"id\":\"1\"}\n\n"])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].data, '{"id":"1"}')
    assert.equal(events[0].event, undefined)
  })

  it("parses multiple events in one chunk", async () => {
    const stream = makeStream([
      'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n',
    ])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 3)
    assert.equal(events[0].data, '{"a":1}')
    assert.equal(events[1].data, '{"b":2}')
    assert.equal(events[2].data, '{"c":3}')
  })

  it("parses event with event: field", async () => {
    const stream = makeStream(["event: message\ndata: hello\n\n"])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].event, "message")
    assert.equal(events[0].data, "hello")
  })

  it("handles data split across chunk boundary", async () => {
    const stream = makeStream([
      'data: {"pa',
      'rt":"split"}\n\n',
    ])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].data, '{"part":"split"}')
  })

  it("handles event split across three chunks", async () => {
    const stream = makeStream([
      "data: first\n\nda",
      "ta: sec",
      "ond\n\n",
    ])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 2)
    assert.equal(events[0].data, "first")
    assert.equal(events[1].data, "second")
  })

  it("flushes trailing buffer at end of stream", async () => {
    // Event without trailing double newline — flushed when stream ends
    const stream = makeStream(["data: trailing"])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].data, "trailing")
  })

  it("passes through [DONE] sentinel as data", async () => {
    const stream = makeStream(["data: [DONE]\n\n"])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].data, "[DONE]")
  })

  it("skips empty parts between double newlines", async () => {
    const stream = makeStream(["data: one\n\n\n\ndata: two\n\n"])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 2)
    assert.equal(events[0].data, "one")
    assert.equal(events[1].data, "two")
  })

  it("returns no events for empty stream", async () => {
    const stream = makeStream([])
    const events = []
    for await (const event of parseSSE(stream)) {
      events.push(event)
    }
    assert.equal(events.length, 0)
  })
})
