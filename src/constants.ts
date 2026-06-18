import { randomUUID } from "node:crypto"

export const PROXY_CLAUDE_VERSION = "1.7.0"
export const UPDATE_CHECK_URL =
  "https://api.github.com/repos/aep-edge-microsoft/proxy-claude/contents/package.json?ref=main"

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_API_BASE_URL = "https://api.github.com"
export const GITHUB_CLIENT_ID = process.env.PROXY_CLAUDE_CLIENT_ID || "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = "read:user"
export const DEFAULT_PORT = 0 // 0 = let OS pick a free port

export const FALLBACK_MODELS = [
  { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "claude-opus-4", name: "Claude Opus 4" },
  { id: "gpt-4.1", name: "GPT-4.1" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  { id: "o4-mini", name: "o4-mini" },
]

// Editor/agent identification headers — configurable via env vars.
// Defaults match VS Code Copilot Chat for maximum API compatibility.
// Override with PROXY_CLAUDE_EDITOR_VERSION, PROXY_CLAUDE_USER_AGENT,
// PROXY_CLAUDE_INTEGRATION_ID to use honest identification.
const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION =
  process.env.PROXY_CLAUDE_PLUGIN_VERSION || `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT =
  process.env.PROXY_CLAUDE_USER_AGENT || `GitHubCopilotChat/${COPILOT_VERSION}`
const API_VERSION = "2025-04-01"
const EDITOR_VERSION =
  process.env.PROXY_CLAUDE_EDITOR_VERSION || "vscode/1.104.3"
const INTEGRATION_ID =
  process.env.PROXY_CLAUDE_INTEGRATION_ID || "vscode-chat"

export const standardHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  accept: "application/json",
})

export const githubHeaders = (githubToken: string): Record<string, string> => ({
  ...standardHeaders(),
  authorization: `token ${githubToken}`,
  "editor-version": EDITOR_VERSION,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
})

export const copilotHeaders = (
  copilotToken: string,
  vision: boolean = false,
): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilotToken}`,
    "content-type": "application/json",
    "copilot-integration-id": INTEGRATION_ID,
    "editor-version": EDITOR_VERSION,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

// ─── Telemetry Constants ────────────────────────────────────────────────────

export const APPINSIGHTS_INSTRUMENTATION_KEY = "252ad67c-64de-404a-bd13-fdc6d43af18b"
export const APPINSIGHTS_INGESTION_ENDPOINT =
  "https://westus2-2.in.applicationinsights.azure.com/v2/track"

// Retail Anthropic/OpenAI pricing (USD per million tokens) — for cost estimation only.
// These are NOT what Copilot charges; they represent equivalent retail value.
import type { ModelPricing } from "./types.ts"

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4":       { inputPerMillion: 15,  outputPerMillion: 75,  cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50 },
  "claude-sonnet-4":     { inputPerMillion: 3,   outputPerMillion: 15,  cacheWritePerMillion: 3.75,  cacheReadPerMillion: 0.30 },
  "claude-sonnet-4-5":   { inputPerMillion: 3,   outputPerMillion: 15,  cacheWritePerMillion: 3.75,  cacheReadPerMillion: 0.30 },
  "claude-3-5-sonnet":   { inputPerMillion: 3,   outputPerMillion: 15,  cacheWritePerMillion: 3.75,  cacheReadPerMillion: 0.30 },
  "claude-3-5-haiku":    { inputPerMillion: 1,   outputPerMillion: 5,   cacheWritePerMillion: 1.25,  cacheReadPerMillion: 0.10 },
  "gpt-4.1":             { inputPerMillion: 2,   outputPerMillion: 8,   cacheWritePerMillion: 0,     cacheReadPerMillion: 0.50 },
  "gpt-4.1-mini":        { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheWritePerMillion: 0,     cacheReadPerMillion: 0.10 },
  "o4-mini":             { inputPerMillion: 1.1, outputPerMillion: 4.4, cacheWritePerMillion: 0,     cacheReadPerMillion: 0.275 },
}

export const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.30,
}
