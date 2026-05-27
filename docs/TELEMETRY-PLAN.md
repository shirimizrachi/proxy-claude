# Telemetry Implementation Plan

## Goal

Add usage telemetry to proxyClaude so a team lead can see:
- **Who** is using it (GitHub usernames)
- **How much** (token counts, request counts)
- **What models** people prefer
- **When** people use it (activity patterns)
- **How well** it works (errors, latency, cache efficiency)
- **Adoption** trends (new users, retention, daily/weekly active)
- **Equivalent cost** (retail Anthropic pricing — justifies the Copilot license)

## Architecture

```
EVERY USER'S MACHINE                              AZURE (one-time setup)
━━━━━━━━━━━━━━━━━━━━                              ━━━━━━━━━━━━━━━━━━━━

proxyClaude handles a request                     Application Insights
        │                                         resource (a database
        ├─► LOCAL: append to                      with web UI & KQL)
        │   ~/.proxy-claude/usage.jsonl
        │                                         ┌──────────────────┐
        └─► REMOTE: fire-and-forget    ──POST──►  │  Stores events   │
            fetch() to App Insights               │  Queryable (KQL) │
                                                  │  Dashboards      │
                                                  │  Alerts          │
                                                  └──────────────────┘
```

Two outputs, always in parallel:
1. **Local JSONL** — always written, user can inspect their own data
2. **Remote App Insights** — opt-out via `PROXYCLAUDE_TELEMETRY=off`

## Azure Setup (one-time, done by YOU the team lead)

### Step 1: Create the Application Insights resource

```bash
# If you don't have a resource group yet:
az group create --name rg-proxy-claude --location westus2

# Create the App Insights resource:
az monitor app-insights component create \
  --app proxy-claude-telemetry \
  --location westus2 \
  --resource-group rg-proxy-claude \
  --kind web

# Output includes the instrumentationKey — copy it!
# Example: "instrumentationKey": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

Or via Azure Portal:
1. portal.azure.com → Create Resource → "Application Insights"
2. Name: `proxy-claude-telemetry`
3. Region: your team's preferred region
4. Workspace: create new or use existing Log Analytics workspace
5. Click Create → go to resource → copy the Instrumentation Key from Overview page

### Step 2: Distribute the instrumentation key to your team

Add to team setup docs:
```bash
# Add to your shell profile (.bashrc / .zshrc / PowerShell profile):
export APPINSIGHTS_INSTRUMENTATION_KEY="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

> The instrumentation key is **write-only** — it allows sending data but NOT reading.
> Only people with Azure RBAC Reader+ on the resource can view the dashboard.

### Step 3: Build a dashboard (Azure Workbook)

After data starts flowing (within minutes of first use):
1. Azure Portal → your App Insights resource → Workbooks → "+ New"
2. Add KQL query blocks (see "KQL Queries for Dashboard" section below)
3. Share the workbook URL with your team/manager

---

## Files to Create / Modify

### New files:
- `src/telemetry.ts` — telemetry module (local + remote emitter)

### Modified files:
- `src/types.ts` — add telemetry interfaces
- `src/server.ts` — hook telemetry into request lifecycle
- `src/main.ts` — initialize telemetry with user context, flush on shutdown
- `src/auth.ts` — expose `getGitHubUser()` (already exists, just needs export)
- `src/constants.ts` — add App Insights endpoint URL, pricing table

---

## Implementation Steps

### Step 1: Add types (`src/types.ts`)

Add these interfaces at the end of the file:

```typescript
// ─── Telemetry Types ──────────────────────────────────────────────────────────

export interface TelemetryEvent {
  // Timing
  timestamp: string              // ISO 8601
  durationMs: number             // request round-trip time

  // Identity
  user: string                   // GitHub username (plain for local, hashed for remote)

  // Request metadata
  model: string                  // e.g. "claude-sonnet-4"
  stream: boolean
  messageCount: number           // number of messages in conversation
  toolCount: number              // number of tool definitions sent
  hasThinking: boolean           // extended thinking enabled?

  // Response metadata
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  stopReason: string             // "end_turn" | "max_tokens" | "tool_use" | ...

  // Derived insights
  hourOfDay: number              // 0-23 (local time)
  dayOfWeek: string              // "Mon" | "Tue" | ... (local time)
  estimatedCostUSD: number       // retail Anthropic equivalent

  // Errors
  success: boolean
  errorType?: string             // "rate_limit" | "context_length" | "auth" | "api_error"
  errorStatus?: number           // HTTP status code from Copilot API
}

export interface TelemetryContext {
  githubUsername: string
  copilotSku?: string            // "business" | "enterprise" | "individual"
  proxyVersion: string
  sessionId: string              // random UUID per proxy session
}

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheWritePerMillion: number
  cacheReadPerMillion: number
}
```

### Step 2: Add constants (`src/constants.ts`)

Add to the end of the file:

```typescript
// ─── Telemetry Constants ────────────────────────────────────────────────────

export const APPINSIGHTS_INGESTION_URL =
  "https://dc.services.visualstudio.com/v2/track"

// Retail Anthropic pricing (USD per million tokens) — for cost estimation only
// These are NOT what Copilot charges; they show "equivalent retail value"
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4":       { inputPerMillion: 15,  outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50 },
  "claude-sonnet-4":     { inputPerMillion: 3,   outputPerMillion: 15, cacheWritePerMillion: 3.75,  cacheReadPerMillion: 0.30 },
  "claude-sonnet-4-5":   { inputPerMillion: 3,   outputPerMillion: 15, cacheWritePerMillion: 3.75,  cacheReadPerMillion: 0.30 },
  "claude-3-5-sonnet":   { inputPerMillion: 3,   outputPerMillion: 15, cacheWritePerMillion: 3.75,  cacheReadPerMillion: 0.30 },
  "claude-3-5-haiku":    { inputPerMillion: 1,   outputPerMillion: 5,  cacheWritePerMillion: 1.25,  cacheReadPerMillion: 0.10 },
  // OpenAI models via Copilot — use approximate pricing
  "gpt-4.1":             { inputPerMillion: 2,   outputPerMillion: 8,  cacheWritePerMillion: 0,     cacheReadPerMillion: 0.50 },
  "gpt-4.1-mini":        { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheWritePerMillion: 0,    cacheReadPerMillion: 0.10 },
  "o4-mini":             { inputPerMillion: 1.1, outputPerMillion: 4.4, cacheWritePerMillion: 0,    cacheReadPerMillion: 0.275 },
}

// Fallback pricing for unknown models
export const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.30,
}
```

### Step 3: Export `getGitHubUser` from `auth.ts`

Currently `getGitHubUser` is a private function. Change:
```typescript
// FROM:
async function getGitHubUser(githubToken: string): Promise<string> {
// TO:
export async function getGitHubUser(githubToken: string): Promise<string> {
```

### Step 4: Create `src/telemetry.ts` (the core module)

This is the main new file. ~120 lines. Responsibilities:

1. **`createTelemetryClient(context)`** — factory that returns `{ track, flush }`
2. **`track(event)`** — records an event to both local JSONL and App Insights
3. **`flush()`** — called on shutdown; writes any buffered events
4. **`estimateCost(model, tokens)`** — computes retail equivalent cost
5. **Internal: `emitToAppInsights(events)`** — batched fire-and-forget POST
6. **Internal: `appendToLocalLog(event)`** — append JSONL line to disk

Key design decisions:
- **Buffering**: Accumulate events in memory, flush to App Insights every 30 seconds OR on shutdown (whichever comes first). Local JSONL is written immediately (append, no buffering).
- **Failure isolation**: All telemetry code wrapped in try/catch. Never throws. Never blocks.
- **Opt-out**: Check `process.env.PROXYCLAUDE_TELEMETRY === 'off'` — if set, skip remote emission but still write local JSONL.
- **First-run notice**: Print to stderr on first track() call: what's collected, how to opt out.

Pseudocode structure:
```typescript
import { createHash } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  APPINSIGHTS_INGESTION_URL,
  MODEL_PRICING,
  DEFAULT_PRICING,
} from "./constants.ts"
import type { TelemetryEvent, TelemetryContext, ModelPricing } from "./types.ts"

const FLUSH_INTERVAL_MS = 30_000
const LOCAL_LOG_DIR = join(homedir(), ".proxy-claude")
const LOCAL_LOG_FILE = join(LOCAL_LOG_DIR, "usage.jsonl")

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  // Normalize model name (strip trailing [1m] etc)
  const normalizedModel = model.replace(/\[.*$/, "").trim()
  const pricing: ModelPricing = MODEL_PRICING[normalizedModel] ?? DEFAULT_PRICING
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMillion
  )
}

export function createTelemetryClient(context: TelemetryContext) {
  const instrumentationKey = process.env.APPINSIGHTS_INSTRUMENTATION_KEY
  const remoteEnabled =
    process.env.PROXYCLAUDE_TELEMETRY !== "off" && !!instrumentationKey
  let noticePrinted = false
  let buffer: TelemetryEvent[] = []
  let flushTimer: ReturnType<typeof setInterval> | null = null

  // Start periodic flush
  if (remoteEnabled) {
    flushTimer = setInterval(() => flushRemote(), FLUSH_INTERVAL_MS)
    flushTimer.unref() // don't keep process alive
  }

  function hashUsername(username: string): string {
    return createHash("sha256").update(username).digest("hex").slice(0, 16)
  }

  function printNotice(): void {
    if (noticePrinted) return
    noticePrinted = true
    if (remoteEnabled) {
      console.error("[proxyClaude] Usage telemetry enabled (model, tokens, timing — no code/prompts).")
      console.error("[proxyClaude] Set PROXYCLAUDE_TELEMETRY=off to disable remote reporting.")
    }
    console.error(`[proxyClaude] Local usage log: ${LOCAL_LOG_FILE}`)
  }

  async function appendLocal(event: TelemetryEvent): Promise<void> {
    try {
      await mkdir(LOCAL_LOG_DIR, { recursive: true })
      const line = JSON.stringify(event) + "\n"
      await appendFile(LOCAL_LOG_FILE, line, "utf-8")
    } catch {
      // silently ignore — telemetry must never break the proxy
    }
  }

  async function flushRemote(): Promise<void> {
    if (!remoteEnabled || buffer.length === 0) return
    const events = buffer.splice(0)
    try {
      const envelopes = events.map((e) => ({
        name: "Microsoft.ApplicationInsights.Event",
        time: e.timestamp,
        iKey: instrumentationKey,
        tags: {
          "ai.cloud.role": "proxy-claude",
          "ai.cloud.roleInstance": `v${context.proxyVersion}`,
          "ai.session.id": context.sessionId,
        },
        data: {
          baseType: "EventData",
          baseData: {
            ver: 2,
            name: "ProxyRequest",
            properties: {
              user: hashUsername(e.user),
              model: e.model,
              stream: String(e.stream),
              success: String(e.success),
              errorType: e.errorType ?? "",
              stopReason: e.stopReason ?? "",
              dayOfWeek: e.dayOfWeek,
              hourOfDay: String(e.hourOfDay),
              hasThinking: String(e.hasThinking),
              copilotSku: context.copilotSku ?? "",
            },
            measurements: {
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              cacheReadTokens: e.cacheReadTokens,
              cacheCreationTokens: e.cacheCreationTokens,
              durationMs: e.durationMs,
              estimatedCostUSD: e.estimatedCostUSD,
              messageCount: e.messageCount,
              toolCount: e.toolCount,
            },
          },
        },
      }))

      await fetch(APPINSIGHTS_INGESTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelopes),
      })
    } catch {
      // silently ignore — events are lost, that's OK
    }
  }

  function track(event: TelemetryEvent): void {
    printNotice()
    // Local — always, immediate
    appendLocal(event)
    // Remote — buffer for batch send
    if (remoteEnabled) {
      buffer.push(event)
    }
  }

  async function flush(): Promise<void> {
    if (flushTimer) clearInterval(flushTimer)
    await flushRemote()
  }

  return { track, flush }
}
```

### Step 5: Wire into `server.ts`

Modify the `startServer` function signature to accept a telemetry `track` function:

```typescript
export async function startServer(
  port: number,
  nonce: string,
  getCopilotToken: () => string,
  getCopilotBaseUrl: () => string,
  getModel?: () => string,
  track?: (event: TelemetryEvent) => void,  // ← NEW
): Promise<{ server: http.Server; port: number }>
```

Then in the `/v1/messages` handler:

**At the start of the request** (after parsing payload, ~line 171):
```typescript
const requestStartTime = Date.now()
const now = new Date()
const messageCount = anthropicPayload.messages.length
const toolCount = anthropicPayload.tools?.length ?? 0
const hasThinking = anthropicPayload.thinking?.type === "enabled"
```

**After non-streaming response** (~line 186, after `res.end()`):
```typescript
if (track) {
  const usage = anthropicResponse.usage
  track({
    timestamp: now.toISOString(),
    durationMs: Date.now() - requestStartTime,
    user: "__USER__",   // injected from main.ts context
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
    hourOfDay: now.getHours(),
    dayOfWeek: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()],
    estimatedCostUSD: estimateCost(
      anthropicPayload.model,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
    ),
    success: true,
  })
}
```

**After streaming completes** (~line 259, before `res.end()`):
- Accumulate usage from the streaming `message_start` and `message_delta` events
- Need to track `inputTokens` from the first chunk and `outputTokens` from the final chunk
- Add a small accumulator object alongside `streamState`:
```typescript
const usageAccumulator = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, stopReason: "" }
```
- Populate it as chunks arrive (parse from the events we already translate)
- Emit telemetry event after the streaming loop ends

**After errors** (~lines 262-268):
```typescript
if (track) {
  track({
    // ... same fields but:
    success: false,
    errorType: categorizeError(error),
    errorStatus: error instanceof CopilotApiError ? error.status : undefined,
    inputTokens: 0, outputTokens: 0, // unknown on error
    // ...
  })
}
```

### Step 6: Wire into `main.ts`

In the `main()` function, after authentication and before starting the server:

```typescript
// After Step 2 (authenticate) — get username for telemetry
const githubUsername = await getGitHubUser(githubToken)

// Before Step 4 (start server) — create telemetry client
const telemetry = createTelemetryClient({
  githubUsername,
  copilotSku: undefined,  // set after token exchange
  proxyVersion: PROXY_CLAUDE_VERSION,
  sessionId: nonce,       // reuse the nonce as session ID
})

// Pass track function to startServer:
const { server, port } = await startServer(
  DEFAULT_PORT,
  nonce,
  () => copilotToken,
  () => copilotBaseUrl,
  () => currentModel,
  (event) => telemetry.track({ ...event, user: githubUsername }),  // inject username
)

// In cleanup function — flush telemetry before exit:
const cleanup = (exitCode: number) => {
  telemetry.flush().finally(() => {
    // existing cleanup (close server, remove lock file, etc.)
  })
}
```

### Step 7: Add `/v1/stats` endpoint to `server.ts`

Add a lightweight in-memory stats endpoint for local debugging:

```typescript
if (req.method === "GET" && pathname === "/v1/stats") {
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({
    session: {
      startedAt: serverStartTime,
      uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
      totalRequests: stats.totalRequests,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      totalErrors: stats.totalErrors,
      byModel: Object.fromEntries(stats.byModel),
    },
  }))
  return
}
```

This doesn't require auth — it's local-only and shows only aggregate counts.

---

## What Gets Tracked (and What Doesn't)

### ✅ TRACKED (metadata only)
| Field | Source | Purpose |
|-------|--------|---------|
| GitHub username | OAuth flow | Who's using it |
| Model name | Request payload | Model preference |
| Input/output/cache tokens | Copilot API response | Usage volume |
| Request duration (ms) | Timer around API call | Performance |
| Stream yes/no | Request payload | Usage pattern |
| Hour of day / day of week | Local clock | Activity heatmap |
| Message count | Request payload | Session depth |
| Tool count | Request payload | Complexity |
| Thinking enabled | Request payload | Feature adoption |
| Stop reason | API response | Completion patterns |
| Error type + HTTP status | Error handling | Reliability |
| Estimated retail cost | Calculated | ROI justification |
| Copilot SKU | Token exchange | License tier |

### ❌ NEVER TRACKED
| Field | Reason |
|-------|--------|
| Message content / prompts | Privacy — may contain proprietary code |
| System prompts | Privacy — may contain project context |
| Tool call arguments/results | Privacy — may contain file contents |
| GitHub tokens | Security |
| Copilot tokens | Security |
| Nonce values | Security |
| File paths | Privacy |
| Response content | Privacy |

---

## KQL Queries for Dashboard

These go into an Azure Workbook. Each becomes a panel.

### Panel 1: Active Users (tile)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(7d)
| summarize Users = dcount(tostring(customDimensions.user))
```

### Panel 2: Total Requests (tile)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(7d)
| count
```

### Panel 3: Equivalent Retail Cost (tile)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(30d)
| summarize Cost = round(sum(todouble(customMeasurements.estimatedCostUSD)), 2)
| project strcat("$", Cost)
```

### Panel 4: Daily Usage Trend (timechart)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(30d)
| summarize
    Requests = count(),
    InputTokens = sum(todouble(customMeasurements.inputTokens)),
    OutputTokens = sum(todouble(customMeasurements.outputTokens))
  by bin(timestamp, 1d)
| render timechart
```

### Panel 5: Model Distribution (piechart)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(30d)
| summarize count() by tostring(customDimensions.model)
| render piechart
```

### Panel 6: Activity Heatmap (matrix)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(30d)
| summarize Requests = count()
  by DayOfWeek = tostring(customDimensions.dayOfWeek),
     Hour = toint(customDimensions.hourOfDay)
| order by Hour asc
```

### Panel 7: Per-User Breakdown (table)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(30d)
| extend user = tostring(customDimensions.user)
| summarize
    Requests = count(),
    InputTokens = sum(todouble(customMeasurements.inputTokens)),
    OutputTokens = sum(todouble(customMeasurements.outputTokens)),
    AvgLatencyMs = round(avg(todouble(customMeasurements.durationMs)), 0),
    EstCost = round(sum(todouble(customMeasurements.estimatedCostUSD)), 2),
    ErrorRate = round(100.0 * countif(tostring(customDimensions.success) == "false") / count(), 1)
  by user
| order by Requests desc
```

### Panel 8: Cache Efficiency (barchart)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(7d)
| summarize
    CacheRead = sum(todouble(customMeasurements.cacheReadTokens)),
    TotalInput = sum(todouble(customMeasurements.inputTokens))
  by tostring(customDimensions.user)
| extend CacheRate = iff(TotalInput > 0, round(100.0 * CacheRead / TotalInput, 1), 0.0)
| project user = customDimensions_user, CacheRate
| render barchart
```

### Panel 9: Error Breakdown (piechart)
```kusto
customEvents
| where name == "ProxyRequest" and timestamp > ago(7d)
| where tostring(customDimensions.success) == "false"
| summarize count() by tostring(customDimensions.errorType)
| render piechart
```

### Panel 10: Adoption Curve (timechart)
```kusto
customEvents
| where name == "ProxyRequest"
| summarize FirstSeen = min(timestamp) by tostring(customDimensions.user)
| summarize NewUsers = count() by bin(FirstSeen, 1d)
| order by FirstSeen asc
| extend CumulativeUsers = row_cumsum(NewUsers)
| project FirstSeen, CumulativeUsers
| render timechart
```

---

## Test Plan

### Unit Tests (can run without Azure)

1. **`estimateCost()` function**
   - Known model → correct cost calculation
   - Unknown model → falls back to DEFAULT_PRICING
   - Model name with suffix (e.g. "claude-sonnet-4[1m]") → strips suffix, correct pricing
   - Zero tokens → returns 0

2. **`hashUsername()` function**
   - Same input → same output (deterministic)
   - Different inputs → different outputs
   - Output is 16 hex chars

3. **`createTelemetryClient()` behavior**
   - With `PROXYCLAUDE_TELEMETRY=off` → local JSONL still written, no fetch() calls
   - Without `APPINSIGHTS_INSTRUMENTATION_KEY` → no fetch() calls
   - `track()` never throws even if appendFile fails
   - `flush()` clears the buffer

4. **Local JSONL writing**
   - Creates `~/.proxy-claude/` directory if missing
   - Appends valid JSON lines (parseable with `JSON.parse`)
   - Each line has all required fields
   - File grows across multiple track() calls

5. **Event schema validation**
   - All required fields present in tracked event
   - `hourOfDay` is 0-23
   - `dayOfWeek` is valid 3-letter day
   - `estimatedCostUSD` is non-negative
   - `durationMs` is positive

### Integration Tests (require the proxy to be running)

6. **Non-streaming request telemetry**
   - Send a non-streaming request via the proxy
   - Verify usage.jsonl has a new line with correct model, token counts, `stream: false`

7. **Streaming request telemetry**
   - Send a streaming request via the proxy
   - Verify usage.jsonl has a new line with correct model, token counts, `stream: true`
   - Verify `inputTokens > 0` and `outputTokens > 0`

8. **Error telemetry**
   - Send a request with invalid model → verify JSONL line has `success: false`, correct `errorType`
   - Send a request that triggers rate limit → verify `errorType: "rate_limit"`

9. **`/v1/stats` endpoint**
   - GET /v1/stats → returns JSON with session stats
   - Stats increment after each request
   - `byModel` breakdown is correct

### App Insights Integration Test (requires Azure resource)

10. **End-to-end remote telemetry**
    - Set `APPINSIGHTS_INSTRUMENTATION_KEY` to a real key
    - Send a few requests through the proxy
    - Wait 2-3 minutes (App Insights ingestion delay)
    - Run KQL query: `customEvents | where name == "ProxyRequest" | take 5`
    - Verify events appear with correct properties and measurements

11. **Opt-out test**
    - Set `PROXYCLAUDE_TELEMETRY=off` + valid key
    - Send requests
    - Verify NO events in App Insights (wait 5 minutes)
    - Verify local JSONL still has events

12. **Batch flush test**
    - Send 10 rapid requests
    - Kill the proxy (Ctrl+C)
    - Verify all 10 events appear in App Insights (flush on shutdown)

---

## Agent Team Plan

For parallel implementation, split into 3 workstreams:

### Agent 1: "telemetry-core"
- Create `src/telemetry.ts` (the full module)
- Add types to `src/types.ts`
- Add constants to `src/constants.ts`
- Export `getGitHubUser` from `src/auth.ts`
- **Depends on:** nothing
- **Blocked by:** nothing

### Agent 2: "telemetry-hooks"
- Modify `src/server.ts` — add request timing, usage accumulation, track() calls
- Modify `src/main.ts` — initialize telemetry, pass to server, flush on cleanup
- Add `/v1/stats` endpoint
- **Depends on:** Agent 1 (needs the types and telemetry module)
- **Blocked by:** Agent 1

### Agent 3: "telemetry-tests"
- Write unit tests for `estimateCost`, `hashUsername`, event schema
- Write integration test scripts (shell scripts that curl the proxy and check JSONL)
- **Depends on:** Agent 1 + Agent 2
- **Blocked by:** Agent 1 + Agent 2

### Execution Order:
```
Agent 1 (types + constants + telemetry.ts)
    │
    ▼
Agent 2 (server.ts + main.ts hooks)  ──►  Agent 3 (tests)
```

In practice: Agent 1 runs first, then Agent 2 and Agent 3 can be parallelized
since Agent 3 can write test stubs while Agent 2 wires things up, then Agent 3
validates at the end.

---

## Local JSONL Format

Each line in `~/.proxy-claude/usage.jsonl`:

```json
{"timestamp":"2025-01-15T14:23:01.123Z","durationMs":2100,"user":"jdoe","model":"claude-sonnet-4","stream":true,"messageCount":12,"toolCount":3,"hasThinking":false,"inputTokens":1523,"outputTokens":342,"cacheReadTokens":800,"cacheCreationTokens":0,"stopReason":"end_turn","hourOfDay":14,"dayOfWeek":"Wed","estimatedCostUSD":0.0097,"success":true}
```

One line per request. Can be processed with `jq`, imported into Excel, or read by a future local dashboard tool.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Telemetry breaks the proxy | Every telemetry call wrapped in try/catch; fire-and-forget |
| Network latency from fetch() | Non-blocking; buffered; timer is `.unref()`'d |
| Disk I/O from JSONL | Single append per request; async; error swallowed |
| JSONL file grows forever | Future: add rotation (not in v1; file grows ~100 bytes/request ≈ 10MB/100K requests) |
| User opts out of everything | Local JSONL still written; only remote is opt-out. Could add `PROXYCLAUDE_TELEMETRY=none` for full off |
| App Insights key not set | Remote telemetry silently disabled; local still works |
| Privacy concern with usernames | Hashed with SHA-256 for remote; plaintext only in local file on user's own machine |
| Streaming usage not captured | Accumulate from message_start + message_delta events (already parsed in translate-stream.ts) |
