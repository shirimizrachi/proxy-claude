#!/usr/bin/env node
/**
 * Telemetry integration test suite for proxyClaude.
 *
 * Usage:
 *   1. Kill any running proxy: Stop-Process -Id <pid> -Force
 *   2. Remove old lock & log: Remove-Item ~/.proxy-claude/server.lock, ~/.proxy-claude/usage.jsonl
 *   3. Build: npm run build
 *   4. Start proxy: node dist/main.js  (in another terminal)
 *   5. Read port/nonce from lock file
 *   6. Run: node tests/test-telemetry.mjs <port> <nonce>
 *
 * Or use the automated runner below which reads from the lock file.
 */

import { readFileSync, existsSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOCK_FILE = join(homedir(), ".proxy-claude", "server.lock")
const USAGE_LOG = join(homedir(), ".proxy-claude", "usage.jsonl")
const HMAC_KEY_FILE = join(homedir(), ".proxy-claude", "telemetry.key")

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition, testName, detail = "") {
  if (condition) {
    console.log(`  ✅ ${testName}`)
    passed++
  } else {
    console.log(`  ❌ ${testName}${detail ? ` — ${detail}` : ""}`)
    failed++
  }
}

async function fetchJSON(url, options = {}) {
  const resp = await fetch(url, options)
  const text = await resp.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: resp.status, body }
}

// ─── Read lock file ───────────────────────────────────────────────────────────

let port, nonce

if (process.argv[2] && process.argv[3]) {
  port = process.argv[2]
  nonce = process.argv[3]
} else if (existsSync(LOCK_FILE)) {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf-8"))
  port = lock.port
  nonce = lock.nonce
} else {
  console.error("ERROR: No proxy running. Start it first: node dist/main.js")
  console.error("       Or pass port and nonce: node tests/test-telemetry.mjs <port> <nonce>")
  process.exit(1)
}

const BASE = `http://127.0.0.1:${port}`
console.log(`\nTesting proxy at ${BASE}\n`)

// ─── Test 1: Health check ─────────────────────────────────────────────────────

console.log("1. Health check")
{
  const { status, body } = await fetchJSON(`${BASE}/`)
  assert(status === 200, "GET / returns 200")
  assert(body?.status === "ok", "GET / returns {status: 'ok'}")
}

// ─── Test 2: /v1/stats requires auth ──────────────────────────────────────────

console.log("\n2. /v1/stats authentication")
{
  const noAuth = await fetchJSON(`${BASE}/v1/stats`)
  assert(noAuth.status === 401, "GET /v1/stats without auth returns 401")

  const wrongAuth = await fetchJSON(`${BASE}/v1/stats`, {
    headers: { "x-api-key": "wrong-nonce" },
  })
  assert(wrongAuth.status === 401, "GET /v1/stats with wrong nonce returns 401")

  const goodAuth = await fetchJSON(`${BASE}/v1/stats`, {
    headers: { "x-api-key": nonce },
  })
  assert(goodAuth.status === 200, "GET /v1/stats with valid nonce returns 200")
  assert(typeof goodAuth.body?.session === "object", "GET /v1/stats returns session object")
  assert(typeof goodAuth.body?.session?.totalRequests === "number", "Stats has totalRequests")
  assert(typeof goodAuth.body?.session?.totalEstimatedCostUSD === "number", "Stats has totalEstimatedCostUSD")
  assert(typeof goodAuth.body?.session?.byModel === "object", "Stats has byModel breakdown")
}

// ─── Test 3: Auth rejection on /v1/messages ───────────────────────────────────

console.log("\n3. /v1/messages auth rejection")
{
  const { status } = await fetchJSON(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "bad-nonce" },
    body: JSON.stringify({
      model: "claude-sonnet-4",
      max_tokens: 10,
      messages: [{ role: "user", content: "test" }],
    }),
  })
  assert(status === 401, "POST /v1/messages with bad nonce returns 401")
}

// ─── Test 4: Non-streaming request + telemetry ────────────────────────────────

console.log("\n4. Non-streaming request + telemetry")

// Count existing JSONL lines
const linesBefore = existsSync(USAGE_LOG)
  ? readFileSync(USAGE_LOG, "utf-8").trim().split("\n").filter(Boolean).length
  : 0

{
  const { status, body } = await fetchJSON(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": nonce },
    body: JSON.stringify({
      model: "claude-sonnet-4",
      max_tokens: 50,
      stream: false,
      messages: [{ role: "user", content: "Say hello in exactly 3 words" }],
    }),
  })
  assert(status === 200, "Non-streaming request returns 200")
  assert(body?.type === "message", "Response type is 'message'")
  assert(body?.usage?.input_tokens > 0, `Has input_tokens (${body?.usage?.input_tokens})`)
  assert(body?.usage?.output_tokens > 0, `Has output_tokens (${body?.usage?.output_tokens})`)
}

// Wait for async JSONL write
await new Promise(r => setTimeout(r, 500))

{
  const linesAfter = existsSync(USAGE_LOG)
    ? readFileSync(USAGE_LOG, "utf-8").trim().split("\n").filter(Boolean).length
    : 0
  assert(linesAfter > linesBefore, `JSONL log grew (${linesBefore} → ${linesAfter})`)

  if (linesAfter > linesBefore) {
    const lines = readFileSync(USAGE_LOG, "utf-8").trim().split("\n")
    const lastEvent = JSON.parse(lines[lines.length - 1])
    assert(lastEvent.model === "claude-sonnet-4", `Event model is claude-sonnet-4 (got: ${lastEvent.model})`)
    assert(lastEvent.stream === false, "Event stream is false")
    assert(lastEvent.success === true, "Event success is true")
    assert(lastEvent.inputTokens > 0, `Event has inputTokens (${lastEvent.inputTokens})`)
    assert(lastEvent.outputTokens > 0, `Event has outputTokens (${lastEvent.outputTokens})`)
    assert(lastEvent.durationMs > 0, `Event has durationMs (${lastEvent.durationMs})`)
    assert(lastEvent.estimatedCostUSD > 0, `Event has estimatedCostUSD (${lastEvent.estimatedCostUSD})`)
    assert(typeof lastEvent.hourOfDay === "number", "Event has hourOfDay")
    assert(["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].includes(lastEvent.dayOfWeek),
      `Event dayOfWeek is valid (${lastEvent.dayOfWeek})`)
    assert(lastEvent.user && lastEvent.user !== "", `Event has user (${lastEvent.user})`)
    assert(!lastEvent.user.includes(" "), "Event user has no spaces (not raw display name)")

    // Check float precision
    const costStr = String(lastEvent.estimatedCostUSD)
    const decimals = costStr.includes(".") ? costStr.split(".")[1].length : 0
    assert(decimals <= 6, `Cost has ≤6 decimal places (${costStr})`)
  }
}

// ─── Test 5: Streaming request + telemetry ────────────────────────────────────

console.log("\n5. Streaming request + telemetry")

const linesBeforeStream = existsSync(USAGE_LOG)
  ? readFileSync(USAGE_LOG, "utf-8").trim().split("\n").filter(Boolean).length
  : 0

{
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": nonce },
    body: JSON.stringify({
      model: "claude-sonnet-4",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Say hello in exactly 3 words" }],
    }),
  })
  assert(resp.status === 200, "Streaming request returns 200")
  assert(resp.headers.get("content-type") === "text/event-stream", "Content-Type is text/event-stream")

  const text = await resp.text()
  const sseLines = text.split("\n").filter(l => l.startsWith("event:"))
  const eventTypes = sseLines.map(l => l.replace("event: ", ""))

  assert(eventTypes.includes("message_start"), "SSE has message_start event")
  assert(eventTypes.includes("message_stop"), "SSE has message_stop event")
  assert(eventTypes.includes("content_block_delta"), "SSE has content_block_delta events")
}

// Wait for async JSONL write
await new Promise(r => setTimeout(r, 500))

{
  const linesAfterStream = existsSync(USAGE_LOG)
    ? readFileSync(USAGE_LOG, "utf-8").trim().split("\n").filter(Boolean).length
    : 0
  assert(linesAfterStream > linesBeforeStream, `JSONL log grew after streaming (${linesBeforeStream} → ${linesAfterStream})`)

  if (linesAfterStream > linesBeforeStream) {
    const lines = readFileSync(USAGE_LOG, "utf-8").trim().split("\n")
    const lastEvent = JSON.parse(lines[lines.length - 1])
    assert(lastEvent.stream === true, "Stream event has stream: true")
    assert(lastEvent.success === true, "Stream event has success: true")
    assert(lastEvent.inputTokens > 0, `Stream event has inputTokens (${lastEvent.inputTokens})`)
    assert(lastEvent.outputTokens > 0, `Stream event has outputTokens (${lastEvent.outputTokens})`)
  }
}

// ─── Test 6: /v1/stats reflects new requests ─────────────────────────────────

console.log("\n6. /v1/stats reflects requests")
{
  const { body } = await fetchJSON(`${BASE}/v1/stats`, {
    headers: { "x-api-key": nonce },
  })
  const s = body.session
  assert(s.totalRequests >= 2, `totalRequests ≥ 2 (got: ${s.totalRequests})`)
  assert(s.totalInputTokens > 0, `totalInputTokens > 0 (got: ${s.totalInputTokens})`)
  assert(s.totalOutputTokens > 0, `totalOutputTokens > 0 (got: ${s.totalOutputTokens})`)
  assert(s.totalEstimatedCostUSD > 0, `totalEstimatedCostUSD > 0 (got: ${s.totalEstimatedCostUSD})`)

  // Check that cost doesn't have extreme float drift
  const costStr = String(s.totalEstimatedCostUSD)
  const decimals = costStr.includes(".") ? costStr.split(".")[1].length : 0
  assert(decimals <= 6, `Stats cost has ≤6 decimal places (${costStr})`)
}

// ─── Test 7: HMAC key file exists ─────────────────────────────────────────────

console.log("\n7. HMAC key file")
{
  assert(existsSync(HMAC_KEY_FILE), "telemetry.key file exists")
  if (existsSync(HMAC_KEY_FILE)) {
    const key = readFileSync(HMAC_KEY_FILE, "utf-8").trim()
    assert(key.length >= 32, `HMAC key is ≥32 chars (got: ${key.length})`)
  }
}

// ─── Test 8: JSONL events have no sensitive data ──────────────────────────────

console.log("\n8. JSONL privacy check")
{
  if (existsSync(USAGE_LOG)) {
    const content = readFileSync(USAGE_LOG, "utf-8")
    assert(!content.includes("x-api-key"), "JSONL does not contain x-api-key")
    assert(!content.includes(nonce), "JSONL does not contain the nonce")

    // Check all events have the expected schema
    const lines = content.trim().split("\n").filter(Boolean)
    let allValid = true
    const requiredFields = [
      "timestamp", "durationMs", "user", "model", "stream",
      "messageCount", "toolCount", "hasThinking", "inputTokens",
      "outputTokens", "cacheReadTokens", "stopReason", "hourOfDay",
      "dayOfWeek", "estimatedCostUSD", "success",
    ]
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        for (const field of requiredFields) {
          if (event[field] === undefined) {
            allValid = false
          }
        }
      } catch {
        allValid = false
      }
    }
    assert(allValid, `All ${lines.length} JSONL events have required fields`)
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) {
  console.log("\n⚠️  Some tests failed!")
  process.exit(1)
} else {
  console.log("\n🎉 All tests passed!")
}
