import { createHash, createHmac, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  APPINSIGHTS_INSTRUMENTATION_KEY,
  APPINSIGHTS_INGESTION_ENDPOINT,
  MODEL_PRICING,
  DEFAULT_PRICING,
  PROXY_CLAUDE_VERSION,
} from "./constants.ts"
import { logToFile } from "./log.ts"
import type { TelemetryEvent, TelemetryContext, ModelPricing } from "./types.ts"

const FLUSH_INTERVAL_MS = 30_000
const MAX_BUFFER_SIZE = 1000
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB — triggers rotation
const LOCAL_LOG_DIR = join(homedir(), ".proxy-claude")
const LOCAL_LOG_FILE = join(LOCAL_LOG_DIR, "usage.jsonl")
const LOCAL_LOG_PREV = join(LOCAL_LOG_DIR, "usage.prev.jsonl")
const HMAC_KEY_FILE = join(LOCAL_LOG_DIR, "telemetry.key")

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

/**
 * Get or create a per-installation HMAC key for username hashing.
 * This prevents rainbow-table attacks on the unsalted SHA-256 of GitHub usernames.
 * The key is stored locally and never sent anywhere.
 */
async function getOrCreateHmacKey(): Promise<string> {
  try {
    const key = await readFile(HMAC_KEY_FILE, "utf-8")
    if (key.trim().length >= 32) return key.trim()
  } catch {
    // File doesn't exist or unreadable — create a new key
  }
  const newKey = randomUUID() + randomUUID()
  try {
    await mkdir(LOCAL_LOG_DIR, { recursive: true })
    await writeFile(HMAC_KEY_FILE, newKey, { encoding: "utf-8", mode: 0o600 })
  } catch {
    // If we can't persist, use ephemeral key (hashes won't correlate across sessions)
  }
  return newKey
}

/**
 * Rotate the local log if it exceeds MAX_LOG_SIZE_BYTES.
 * Keeps one previous file (usage.prev.jsonl) so ~10 MB max on disk.
 */
async function rotateLogIfNeeded(): Promise<void> {
  try {
    const info = await stat(LOCAL_LOG_FILE)
    if (info.size > MAX_LOG_SIZE_BYTES) {
      // Rename current → prev (overwrites any existing prev)
      await rename(LOCAL_LOG_FILE, LOCAL_LOG_PREV)
    }
  } catch {
    // File doesn't exist or can't stat — nothing to rotate
  }
}

/**
 * Normalize model name for pricing lookup.
 * Strips [1m] suffixes and date-based version suffixes.
 */
function normalizeModelName(model: string): string {
  return model
    .replace(/\[.*$/, "")                                    // strip [1m] etc
    .replace(/-\d{8}$/, "")                                  // strip -20250514 date suffixes
    .trim()
}

/**
 * Estimate the equivalent retail cost for a request based on model pricing.
 * This does NOT reflect actual Copilot billing — it's for ROI visualization.
 * Returns a value rounded to 6 decimal places to avoid float drift.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const normalizedModel = normalizeModelName(model)
  const pricing: ModelPricing = MODEL_PRICING[normalizedModel] ?? DEFAULT_PRICING
  const raw =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMillion
  return Math.round(raw * 1_000_000) / 1_000_000
}

/**
 * Build a TelemetryEvent from request/response data.
 * Centralizes event construction so callers just pass raw data.
 */
export function buildTelemetryEvent(params: {
  user: string
  model: string
  stream: boolean
  messageCount: number
  toolCount: number
  hasThinking: boolean
  requestedEffort?: string
  sentEffort?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  stopReason: string
  durationMs: number
  success: boolean
  copilotApiUrl?: string
  copilotRequestId?: string
  copilotCompletionId?: string
  copilotModelServed?: string
  systemFingerprint?: string
  errorType?: string
  errorStatus?: number
}): TelemetryEvent {
  const now = new Date()
  return {
    timestamp: now.toISOString(),
    durationMs: params.durationMs,
    user: params.user,
    model: params.model,
    stream: params.stream,
    messageCount: params.messageCount,
    toolCount: params.toolCount,
    hasThinking: params.hasThinking,
    proxyVersion: PROXY_CLAUDE_VERSION,
    requestedEffort: params.requestedEffort,
    sentEffort: params.sentEffort,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cacheReadTokens,
    cacheCreationTokens: params.cacheCreationTokens,
    stopReason: params.stopReason,
    hourOfDay: now.getHours(),
    dayOfWeek: DAY_NAMES[now.getDay()],
    estimatedCostUSD: estimateCost(
      params.model,
      params.inputTokens,
      params.outputTokens,
      params.cacheReadTokens,
      params.cacheCreationTokens,
    ),
    copilotApiUrl: params.copilotApiUrl,
    copilotRequestId: params.copilotRequestId,
    copilotCompletionId: params.copilotCompletionId,
    copilotModelServed: params.copilotModelServed,
    systemFingerprint: params.systemFingerprint,
    success: params.success,
    errorType: params.errorType,
    errorStatus: params.errorStatus,
  }
}

/**
 * Create a telemetry client that emits usage events to:
 * 1. A local JSONL file (always, for user transparency)
 * 2. Azure Application Insights (opt-out via PROXYCLAUDE_TELEMETRY=off)
 *
 * Privacy: usernames are HMAC'd with a local secret before remote send.
 * The auth nonce is never sent — a separate session ID is generated.
 */
export function createTelemetryClient(context: TelemetryContext) {
  const iKey =
    process.env.APPINSIGHTS_INSTRUMENTATION_KEY ?? APPINSIGHTS_INSTRUMENTATION_KEY
  const ingestionUrl =
    process.env.APPINSIGHTS_INGESTION_ENDPOINT ?? APPINSIGHTS_INGESTION_ENDPOINT
  const remoteEnabled = process.env.PROXYCLAUDE_TELEMETRY !== "off"
  let buffer: TelemetryEvent[] = []
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let hmacKey: string | null = null
  let dirEnsured = false

  // Generate a separate session ID for telemetry — never reuse the auth nonce
  const telemetrySessionId = randomUUID()

  // Rotate local log if it's too large (runs once at startup)
  rotateLogIfNeeded()

  // Load HMAC key asynchronously (best-effort; falls back to plain SHA-256)
  const hmacKeyReady = getOrCreateHmacKey().then((key) => {
    hmacKey = key
  }).catch(() => {
    // Fall back to plain hash if key setup fails
  })

  // Start periodic flush for remote telemetry
  if (remoteEnabled) {
    flushTimer = setInterval(() => {
      flushRemote()
    }, FLUSH_INTERVAL_MS)
    flushTimer.unref() // don't keep the process alive for telemetry
  }

  function hashUsername(username: string): string {
    if (hmacKey) {
      return createHmac("sha256", hmacKey).update(username).digest("hex").slice(0, 16)
    }
    // Fallback: salted hash with a static prefix (better than plain SHA-256)
    return createHash("sha256").update(`proxyClaude:${username}`).digest("hex").slice(0, 16)
  }

  function printNotice(): void {
    if (remoteEnabled) {
      console.error(
        "[proxyClaude] Telemetry: sending usage metrics (user hash, model, tokens, timing, cost).",
      )
      console.error(
        "[proxyClaude] No code, prompts, or file paths are collected. Set PROXYCLAUDE_TELEMETRY=off to disable.",
      )
    }
    console.error(`[proxyClaude] Local usage log: ${LOCAL_LOG_FILE}`)
  }

  async function appendLocal(event: TelemetryEvent): Promise<void> {
    try {
      if (!dirEnsured) {
        await mkdir(LOCAL_LOG_DIR, { recursive: true })
        dirEnsured = true
      }
      await appendFile(LOCAL_LOG_FILE, JSON.stringify(event) + "\n", { encoding: "utf-8", mode: 0o600 })
    } catch {
      // Telemetry must never break the proxy
    }
  }

  // Serialize local writes to prevent interleaving on Windows
  let writeQueue = Promise.resolve()

  async function flushRemote(): Promise<void> {
    if (!remoteEnabled || buffer.length === 0) return

    const events = buffer.splice(0)
    try {
      // Ensure HMAC key is loaded before hashing
      await hmacKeyReady

      const envelopes = events.map((e) => ({
        name: "Microsoft.ApplicationInsights.Event",
        time: e.timestamp,
        iKey,
        tags: {
          "ai.cloud.role": "proxy-claude",
          "ai.cloud.roleInstance": `v${context.proxyVersion}`,
          "ai.session.id": telemetrySessionId,
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
              stopReason: e.stopReason,
              dayOfWeek: e.dayOfWeek,
              hourOfDay: String(e.hourOfDay),
              hasThinking: String(e.hasThinking),
              proxyVersion: e.proxyVersion,
              requestedEffort: e.requestedEffort ?? "",
              sentEffort: e.sentEffort ?? "",
              effortClamped: String(
                e.requestedEffort !== undefined &&
                e.sentEffort !== undefined &&
                e.requestedEffort !== e.sentEffort,
              ),
              copilotSku: context.copilotSku ?? "",
              copilotApiUrl: e.copilotApiUrl ?? "",
              copilotRequestId: e.copilotRequestId ?? "",
              copilotCompletionId: e.copilotCompletionId ?? "",
              copilotModelServed: e.copilotModelServed ?? "",
              systemFingerprint: e.systemFingerprint ?? "",
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

      const resp = await fetch(ingestionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelopes),
      })
      if (!resp.ok) {
        logToFile(`Telemetry flush failed: HTTP ${resp.status}`)
      }
    } catch {
      // Silently drop — telemetry loss is acceptable
    }
  }

  /**
   * Track a telemetry event. Writes to local JSONL immediately
   * and buffers for remote batch send.
   */
  function track(event: TelemetryEvent): void {
    // Local — always, immediate, serialized writes
    writeQueue = writeQueue.then(() => appendLocal(event))
    // Remote — buffer for batch send (capped to prevent unbounded growth)
    if (remoteEnabled) {
      if (buffer.length >= MAX_BUFFER_SIZE) {
        buffer.shift() // Drop oldest event
      }
      buffer.push(event)
    }
  }

  /**
   * Flush any buffered remote events. Call on shutdown.
   */
  async function flush(): Promise<void> {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    await flushRemote()
  }

  return { track, flush, printNotice }
}

/** Type for the telemetry client returned by createTelemetryClient */
export type TelemetryClient = ReturnType<typeof createTelemetryClient>
