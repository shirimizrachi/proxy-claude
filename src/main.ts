import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

import { authenticate, setupCopilotToken, getGitHubUser } from "./auth.ts"
import type { TokenManager } from "./auth.ts"
import { getModels } from "./copilot.ts"
import { DEFAULT_PORT, FALLBACK_MODELS, PROXY_CLAUDE_VERSION } from "./constants.ts"
import {
  ensureClaudeCode,
  ensureAgency,
  hasModelConfig,
  configureFirstRun,
  updateNonce,
  readSettings,
  resetModelConfig,
  checkForUpdates,
  installStatusLine,
  performUpdate,
  saveRepoPath,
} from "./config.ts"
import { startServer } from "./server.ts"
import {
  checkExistingInstance,
  writeLockFile,
  removeLockFile,
  getServerVersion,
} from "./singleton.ts"
import { createTelemetryClient, type TelemetryClient } from "./telemetry.ts"
import type { CliOptions } from "./types.ts"

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2)
  const separatorIndex = args.indexOf("--")
  const proxyArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const explicitPassthrough =
    separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)

  let useAgency = false
  let resetModels = false
  const claudeArgs: string[] = []

  for (const arg of proxyArgs) {
    if (arg === "--agency") useAgency = true
    else if (arg === "--reset-models") resetModels = true
    else if (arg === "--yolo") { /* handled separately via process.argv */ }
    else claudeArgs.push(arg)
  }

  return { useAgency, resetModels, passthroughArgs: [...claudeArgs, ...explicitPassthrough] }
}

async function main(): Promise<void> {
  // Handle "update" subcommand before normal flow (like `claude update`)
  if (process.argv[2] === "update") {
    await performUpdate()
    return
  }

  const cliOptions = parseCliArgs()

  // Save repo path for future `proxy-claude update` from global installs
  await saveRepoPath()

  // Handle --reset-models flag
  if (cliOptions.resetModels) {
    await resetModelConfig()
  }

  // Handle --yolo flag (dangerously skip permissions in Claude Code)
  const yolo = process.argv.includes("--yolo")

  // Install statusline script + setting early (before ensureClaudeCode may prompt/exit)
  await installStatusLine()

  // Step 0: Check Claude Code CLI (always needed, even with agency)
  await ensureClaudeCode()

  // Check agency CLI if --agency flag is set
  if (cliOptions.useAgency) {
    ensureAgency()
  }

  // Auto-update check (non-blocking — silently skips on failure)
  await checkForUpdates()

  const nonce = randomUUID()

  // Step 1: Check singleton
  const existing = await checkExistingInstance(DEFAULT_PORT)
  if (existing) {
    console.error(
      `[proxyClaude] Proxy already running (pid ${existing.pid}, port ${existing.port})`,
    )

    // Update nonce in settings to the existing instance's nonce
    await updateNonce(existing.nonce)

    // Launch claude with existing proxy
    spawnClaude(existing.port, existing.nonce, null, null, false, cliOptions, yolo)
    return
  }

  // Step 2: Authenticate with GitHub
  const githubToken = await authenticate()

  // Get GitHub username for telemetry
  let githubUsername = "unknown"
  try {
    githubUsername = await getGitHubUser(githubToken)
  } catch {
    // Username is best-effort for telemetry; don't block startup
  }

  // Initialize telemetry
  const telemetry = createTelemetryClient({
    githubUsername,
    proxyVersion: PROXY_CLAUDE_VERSION,
    sessionId: nonce,
  })

  // Step 3: Exchange for Copilot token (also resolves the correct API base URL)
  let copilotToken = ""
  let copilotBaseUrl = ""
  console.error("[proxyClaude] Exchanging for Copilot token...")
  const tokenManager: TokenManager = await setupCopilotToken(
    githubToken,
    (token) => {
      copilotToken = token
    },
    (baseUrl) => {
      copilotBaseUrl = baseUrl
    },
  )
  console.error(`[proxyClaude] Copilot token obtained. API: ${copilotBaseUrl}`)

  // Step 4: Start HTTP proxy server
  console.error("[proxyClaude] Starting proxy server...")
  const getModel = async () => {
    try {
      const s = await readSettings()
      const env = s.env as Record<string, string> | undefined
      return env?.ANTHROPIC_MODEL ?? "claude-sonnet-4"
    } catch {
      return "claude-sonnet-4"
    }
  }
  let currentModel = await getModel()

  const { server, port } = await startServer(
    DEFAULT_PORT,
    nonce,
    () => copilotToken,
    () => copilotBaseUrl,
    () => currentModel,
    (event) => telemetry.track(event),
    () => githubUsername,
    () => tokenManager.refreshNow(),
    () => tokenManager.isTokenHealthy(),
  )
  console.error(`[proxyClaude] Proxy running on http://127.0.0.1:${port}`)

  // Print telemetry notice at startup
  telemetry.printNotice()

  // Step 5: Write lock file
  await writeLockFile({
    pid: process.pid,
    port,
    nonce,
    timestamp: Date.now(),
    version: getServerVersion(),
  })

  // Step 6: Configure Claude Code (first run or missing model config)
  const hasModels = await hasModelConfig()
  if (!hasModels) {
    // Try to fetch models from Copilot API; fall back to hardcoded list
    let models: Array<{ id: string; name: string }> = FALLBACK_MODELS
    try {
      const modelsResponse = await getModels(copilotToken, copilotBaseUrl)
      if (modelsResponse.data.length > 0) {
        models = modelsResponse.data
      }
    } catch {
      console.error(
        "[proxyClaude] Could not fetch models from API, using defaults.",
      )
    }
    await configureFirstRun(models, `http://127.0.0.1:${port}`, nonce)
    currentModel = await getModel()
  } else {
    await updateNonce(nonce, `http://127.0.0.1:${port}`)
  }

  // Step 7: Spawn claude
  spawnClaude(port, nonce, server, tokenManager.refreshTimer, true, cliOptions, yolo, telemetry)
}

function spawnClaude(
  port: number,
  nonce: string,
  server: import("node:http").Server | null,
  refreshTimer: ReturnType<typeof setInterval> | null,
  isOwner: boolean,
  cliOptions: CliOptions,
  yolo: boolean = false,
  telemetry?: TelemetryClient,
): void {
  const command = cliOptions.useAgency ? "agency" : "claude"
  const args = cliOptions.useAgency
    ? ["claude", ...cliOptions.passthroughArgs]
    : [...cliOptions.passthroughArgs]

  if (yolo) {
    args.push("--dangerously-skip-permissions")
    console.error("[proxyClaude] YOLO mode enabled — Claude will not ask for permissions!")
  }

  console.error(
    `[proxyClaude] Launching ${cliOptions.useAgency ? "agency claude" : "Claude Code"}...`,
  )

  const child = spawn(command, args, {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: nonce,
    },
  })

  const cleanup = (exitCode: number) => {
    if (isOwner) {
      if (refreshTimer) clearInterval(refreshTimer)
      if (server) {
        server.close()
      }
      // Flush telemetry before exit, then remove lock file
      const flushPromise = telemetry ? telemetry.flush() : Promise.resolve()
      flushPromise.finally(() => {
        removeLockFile().finally(() => {
          process.exit(exitCode)
        })
      })
    } else {
      process.exit(exitCode)
    }
  }

  child.on("exit", (code) => {
    cleanup(code ?? 0)
  })

  child.on("error", (err) => {
    console.error(`[proxyClaude] Failed to start ${command}:`, err.message)
    cleanup(1)
  })

  // Handle signals
  const onSignal = () => {
    setTimeout(() => cleanup(130), 5000)
  }

  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
}

main().catch((error) => {
  console.error("[proxyClaude] Fatal error:", error)
  process.exit(1)
})
