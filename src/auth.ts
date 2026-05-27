import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Buffer } from "node:buffer"

import {
  GITHUB_BASE_URL,
  GITHUB_API_BASE_URL,
  GITHUB_CLIENT_ID,
  GITHUB_APP_SCOPES,
  standardHeaders,
  githubHeaders,
} from "./constants.ts"
import type { DeviceCodeResponse, CopilotTokenResponse } from "./types.ts"
import { logToFile, formatError } from "./log.ts"

const PROXY_DIR = path.join(os.homedir(), ".proxy-claude")
const TOKEN_FILE = path.join(PROXY_DIR, "github_token")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function readGithubToken(): Promise<string | null> {
  try {
    const token = await fs.readFile(TOKEN_FILE, "utf8")
    return token.trim() || null
  } catch {
    return null
  }
}

async function writeGithubToken(token: string): Promise<void> {
  await fs.mkdir(PROXY_DIR, { recursive: true })
  await fs.writeFile(TOKEN_FILE, token)
  try {
    await fs.chmod(TOKEN_FILE, 0o600)
  } catch {
    // Ignore on Windows where chmod is not meaningful
  }
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_APP_SCOPES,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to get device code: ${response.status}`)
  }

  return (await response.json()) as DeviceCodeResponse
}

async function pollAccessToken(deviceCode: DeviceCodeResponse): Promise<string> {
  const sleepDuration = (deviceCode.interval + 1) * 1000
  const expiresAt = Date.now() + deviceCode.expires_in * 1000

  while (Date.now() < expiresAt) {
    await sleep(sleepDuration)

    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      continue
    }

    const json = (await response.json()) as { access_token?: string; error?: string }

    if (json.access_token) {
      return json.access_token
    }

    if (json.error === "expired_token") {
      throw new Error("Device code expired. Please try again.")
    }
  }

  throw new Error("Device code flow timed out.")
}

export async function getGitHubUser(githubToken: string): Promise<string> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      ...standardHeaders(),
      authorization: `token ${githubToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to get GitHub user: ${response.status}`)
  }

  const json = (await response.json()) as { login: string }
  return json.login
}

export async function getCopilotToken(
  githubToken: string,
): Promise<CopilotTokenResponse> {
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(githubToken),
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to get Copilot token: ${response.status}`)
  }

  return (await response.json()) as CopilotTokenResponse
}

const DEFAULT_COPILOT_BASE_URL = "https://api.business.githubcopilot.com"

export function resolveCopilotBaseUrl(tokenResponse: CopilotTokenResponse): string {
  // Strategy 1: Use the endpoints.api field if present
  if (tokenResponse.endpoints?.api) {
    return tokenResponse.endpoints.api.replace(/\/+$/, "")
  }

  // Strategy 2: Decode the JWT to extract the endpoint
  try {
    const parts = tokenResponse.token.split(".")
    if (parts.length >= 2) {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8"),
      ) as Record<string, unknown>
      if (typeof payload.shu === "string" && payload.shu.startsWith("https://")) {
        return payload.shu.replace(/\/+$/, "")
      }
    }
  } catch {
    // JWT decode failed
  }

  // Strategy 3: Infer from sku field
  if (tokenResponse.sku) {
    if (tokenResponse.sku === "individual") {
      return "https://api.githubcopilot.com"
    }
    return `https://api.${tokenResponse.sku}.githubcopilot.com`
  }

  // Strategy 4: Default fallback
  return DEFAULT_COPILOT_BASE_URL
}

const MAX_REFRESH_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 3_000

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error
    ? (error.cause instanceof Error ? error.cause.message : error.message)
    : String(error)
  return /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|fetch failed|network|socket hang up/i.test(message)
}

export interface TokenManager {
  token: string
  baseUrl: string
  refreshTimer: ReturnType<typeof setInterval>
  /** Force an immediate token refresh (e.g. after a 401). Returns true if successful. */
  refreshNow: () => Promise<boolean>
  /** Returns true if the token is known to be expired or refresh has been failing. */
  isTokenHealthy: () => boolean
}

export async function setupCopilotToken(
  githubToken: string,
  onToken: (token: string) => void,
  onBaseUrl: (baseUrl: string) => void,
): Promise<TokenManager> {
  // Mutable state for token health tracking
  let tokenExpiresAt = 0        // Unix seconds
  let lastRefreshOk = true
  let refreshInFlight = false   // Prevent concurrent refreshes

  async function doRefresh(label: string): Promise<boolean> {
    // Deduplicate: if a refresh is already running, wait for it rather than firing another
    if (refreshInFlight) {
      // Wait up to 30s for the in-flight refresh to finish
      for (let i = 0; i < 60; i++) {
        await sleep(500)
        if (!refreshInFlight) return lastRefreshOk
      }
      return lastRefreshOk
    }

    refreshInFlight = true
    try {
      for (let attempt = 1; attempt <= MAX_REFRESH_RETRIES; attempt++) {
        try {
          const newResponse = await getCopilotToken(githubToken)
          onToken(newResponse.token)
          const newBaseUrl = resolveCopilotBaseUrl(newResponse)
          onBaseUrl(newBaseUrl)
          tokenExpiresAt = newResponse.expires_at
          lastRefreshOk = true
          const expiresIn = Math.round(newResponse.expires_at - Date.now() / 1000)
          const mins = Math.round(expiresIn / 60)
          if (attempt > 1) {
            logToFile(`${label} succeeded on attempt ${attempt}/${MAX_REFRESH_RETRIES} (next expiry in ${mins}m)`)
          } else {
            logToFile(`${label} ✓ (next expiry in ${mins}m)`)
          }
          return true
        } catch (error) {
          const retriable = isTransientError(error)
          if (retriable && attempt < MAX_REFRESH_RETRIES) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
            logToFile(
              `${label} failed (attempt ${attempt}/${MAX_REFRESH_RETRIES}), retrying in ${(delay / 1000).toFixed(0)}s...`,
            )
            await sleep(delay)
          } else {
            logToFile(
              `${label} failed after ${attempt} attempt(s): ${formatError(error)}`,
            )
            lastRefreshOk = false
            return false
          }
        }
      }
      return false
    } finally {
      refreshInFlight = false
    }
  }

  // Initial token fetch (no retries — caller handles startup failure)
  const tokenResponse = await getCopilotToken(githubToken)
  onToken(tokenResponse.token)
  const baseUrl = resolveCopilotBaseUrl(tokenResponse)
  onBaseUrl(baseUrl)
  tokenExpiresAt = tokenResponse.expires_at

  const refreshInterval = (tokenResponse.refresh_in - 60) * 1000
  const refreshTimer = setInterval(() => {
    doRefresh("Token refresh")
  }, refreshInterval)

  return {
    token: tokenResponse.token,
    baseUrl,
    refreshTimer,
    refreshNow: () => doRefresh("On-demand token refresh"),
    isTokenHealthy: () => {
      if (!lastRefreshOk) return false
      // If we know the expiry, check it (with 60s grace)
      if (tokenExpiresAt > 0) {
        const nowSec = Math.floor(Date.now() / 1000)
        if (nowSec >= tokenExpiresAt - 60) return false
      }
      return true
    },
  }
}

export async function authenticate(): Promise<string> {
  const savedToken = await readGithubToken()

  if (savedToken) {
    try {
      await getCopilotToken(savedToken)
      const login = await getGitHubUser(savedToken)
      console.error(`[proxyClaude] Authenticated as ${login}`)
      return savedToken
    } catch {
      console.error(
        "[proxyClaude] Saved token is invalid. Starting new login...",
      )
    }
  }

  console.error("[proxyClaude] No saved token found. Starting GitHub login...")
  console.error("")

  const deviceCode = await requestDeviceCode()

  console.error(
    "  ┌─────────────────────────────────────────────────┐",
  )
  console.error(
    "  │                                                   │",
  )
  console.error(
    `  │   Please enter the code  ${deviceCode.user_code}  at:           │`,
  )
  console.error(
    `  │   ${deviceCode.verification_uri}                 │`,
  )
  console.error(
    "  │                                                   │",
  )
  console.error(
    "  └─────────────────────────────────────────────────┘",
  )
  console.error("")

  const token = await pollAccessToken(deviceCode)
  await writeGithubToken(token)

  const login = await getGitHubUser(token)
  console.error(`[proxyClaude] Logged in as ${login}`)

  return token
}
