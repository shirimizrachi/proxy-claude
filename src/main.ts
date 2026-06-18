import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

import { authenticate, setupCopilotToken, getGitHubUser } from "./auth.ts"
import type { TokenManager } from "./auth.ts"
import { parseCliArgs } from "./cli-options.ts"
import { getModels } from "./copilot.ts"
import { DEFAULT_PORT, FALLBACK_MODELS, PROXY_CLAUDE_VERSION } from "./constants.ts"
import {
  ensureClaudeCode,
  ensureAgency,
  hasModelConfig,
  configureFirstRun,
  updateNonce,
  readSettings,
  writeSettings,
  setEffortFloor,
  resetModelConfig,
  checkForUpdates,
  installStatusLine,
  performUpdate,
  saveRepoPath,
  buildAliasMaps,
  saveAliasMap,
  loadAliasMap,
  emptyAliasMaps,
  resolveClaudeBinary,
  resolveAgencyBinary,
  type AliasMaps,
} from "./config.ts"
import { startServer } from "./server.ts"
import {
  checkExistingInstance,
  writeLockFile,
  removeLockFile,
  getServerVersion,
} from "./singleton.ts"
import { needsShellFor, quoteWindowsArg } from "./spawn-utils.ts"
import { createTelemetryClient, type TelemetryClient } from "./telemetry.ts"
import type { CliOptions, Model, ModelSupports, ModelsResponse } from "./types.ts"

async function main(): Promise<void> {
  // Print version on every launch so users (and bug reports) always know which
  // build is running. Goes to stderr so it doesn't pollute Claude Code's stdio.
  console.error(`[proxyClaude] proxy-claude v${PROXY_CLAUDE_VERSION}`)

  // Handle "update" subcommand before normal flow (like `claude update`)
  if (process.argv[2] === "update") {
    await performUpdate()
    return
  }

  const cliOptions = parseCliArgs(process.argv.slice(2))

  // Save repo path for future `proxy-claude update` from global installs
  await saveRepoPath()

  // Handle --reset-models flag
  if (cliOptions.resetModels) {
    await resetModelConfig()
    console.error(
      "[proxyClaude] Model configuration reset. Restart any active Claude Code sessions to pick up the new model.",
    )
  }

  // Handle --effort flag (persist to settings.json)
  if (cliOptions.effort) {
    const settings = await readSettings()
    const env = (settings.env ?? {}) as Record<string, string>
    setEffortFloor(env, cliOptions.effort)
    if (cliOptions.effort === "auto") {
      console.error("[proxyClaude] Effort floor removed (Claude Code decides)")
    } else {
      console.error(`[proxyClaude] Effort floor set to: ${cliOptions.effort}`)
    }
    settings.env = env
    await writeSettings(settings)
  }

  // Handle --yolo flag (dangerously skip permissions in Claude Code)
  const yolo = process.argv.includes("--yolo")

  // Install statusline script + setting early (before ensureClaudeCode may prompt/exit)
  await installStatusLine()

  // Step 0: Check Claude Code CLI (always needed, even with agency)
  await ensureClaudeCode()

  // Check agency CLI when agency runtime is selected
  const effectiveCliOptions =
    cliOptions.useAgency && !ensureAgency()
      ? { ...cliOptions, useAgency: false }
      : cliOptions

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
    spawnClaude(
      existing.port,
      existing.nonce,
      null,
      null,
      false,
      effectiveCliOptions,
      yolo,
    )
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
  const getEnvVar = async (key: string) => {
    try {
      const s = await readSettings()
      const env = s.env as Record<string, string> | undefined
      return env?.[key]
    } catch {
      return undefined
    }
  }
  let currentModel = await getModel()
  let currentSonnet = (await getEnvVar("ANTHROPIC_DEFAULT_SONNET_MODEL")) ?? currentModel
  let currentHaiku = (await getEnvVar("ANTHROPIC_DEFAULT_HAIKU_MODEL")) ?? currentModel
  let currentSmallFast = (await getEnvVar("ANTHROPIC_SMALL_FAST_MODEL")) ?? currentHaiku

  // Fetch the models list once at startup. Used to seed the first-run model
  // picker, build the per-model capabilities cache (powers effort clamping),
  // and build the alias map (translates dot-versioned GHCP ids to the
  // dash-canonical form Claude Code's substring matchers recognize).
  //
  // A failure here is non-fatal: capabilities are empty (effort silently
  // dropped), the picker falls back to FALLBACK_MODELS, and the alias map
  // is loaded from ~/.proxy-claude/model-aliases.json so prior aliases keep
  // working through transient network issues.
  let cachedModels: Array<Model> | null = null
  try {
    const modelsResponse: ModelsResponse = await getModels(copilotToken, copilotBaseUrl)
    if (modelsResponse.data.length > 0) {
      cachedModels = modelsResponse.data
    }
  } catch {
    console.error(
      "[proxyClaude] Could not fetch models from Copilot API; effort clamping disabled.",
    )
  }

  const capabilitiesByModel = new Map<string, ModelSupports>()
  if (cachedModels) {
    for (const m of cachedModels) {
      if (m.id && m.capabilities?.supports) {
        capabilitiesByModel.set(m.id, m.capabilities.supports)
      }
    }
  }

  let aliasMaps: AliasMaps
  if (cachedModels) {
    aliasMaps = buildAliasMaps(cachedModels)
    // Persist for future runs when /models is unavailable.
    await saveAliasMap(aliasMaps)
  } else {
    aliasMaps = await loadAliasMap()
    if (aliasMaps.aliasToReal.size > 0) {
      console.error(
        `[proxyClaude] Loaded ${aliasMaps.aliasToReal.size} model alias(es) from disk.`,
      )
    } else {
      aliasMaps = emptyAliasMaps()
    }
  }

  const { server, port } = await startServer({
    port: DEFAULT_PORT,
    nonce,
    getCopilotToken: () => copilotToken,
    getCopilotBaseUrl: () => copilotBaseUrl,
    getModel: () => currentModel,
    onTelemetry: (event) => telemetry.track(event),
    getUsername: () => githubUsername,
    refreshToken: () => tokenManager.refreshNow(),
    isTokenHealthy: () => tokenManager.isTokenHealthy(),
    getModelConfig: () => ({
      primary: currentModel,
      sonnet: currentSonnet,
      haiku: currentHaiku,
      smallFast: currentSmallFast,
    }),
    getModelCapabilities: (id) => capabilitiesByModel.get(id),
    resolveAlias: (alias) => aliasMaps.aliasToReal.get(alias),
  })
  console.error(`[proxyClaude] Proxy running on http://127.0.0.1:${port}`)

  // Log effort floor if configured
  const effortFloor = process.env.PROXY_CLAUDE_MIN_EFFORT
  if (effortFloor) {
    console.error(`[proxyClaude] Effort floor: ${effortFloor}`)
  }

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
    // Reuse the models we already fetched above; fall back to defaults if that
    // fetch failed.
    const models: Array<{ id: string; name: string }> = cachedModels ?? FALLBACK_MODELS
    await configureFirstRun(
      models,
      `http://127.0.0.1:${port}`,
      nonce,
      aliasMaps,
    )
    currentModel = await getModel()
    currentSonnet = (await getEnvVar("ANTHROPIC_DEFAULT_SONNET_MODEL")) ?? currentModel
    currentHaiku = (await getEnvVar("ANTHROPIC_DEFAULT_HAIKU_MODEL")) ?? currentModel
    currentSmallFast = (await getEnvVar("ANTHROPIC_SMALL_FAST_MODEL")) ?? currentHaiku
  } else {
    await updateNonce(nonce, `http://127.0.0.1:${port}`)
  }

  // Belt-and-suspenders for effort passthrough: Claude Code's substring
  // matcher (modelSupportsEffort) only allowlists opus-4-6 / sonnet-4-6, so
  // even with the alias rewrite, models like opus-4-7 wouldn't trigger the
  // client-side effort code path. CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 forces
  // it to true regardless. We only inject the env var when the primary model
  // is known to support reasoning_effort on the GHCP side — otherwise GHCP
  // would reject the request with "reasoning_effort not supported".
  const primaryRealId = aliasMaps.aliasToReal.get(
    currentModel.replace(/\[1m\]$/, ""),
  ) ?? currentModel.replace(/\[1m\]$/, "")
  const primaryCaps = capabilitiesByModel.get(primaryRealId)
  const extraEnv: Record<string, string> = {}
  if (primaryCaps?.reasoning_effort && primaryCaps.reasoning_effort.length > 0) {
    extraEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1"
    console.error(
      `[proxyClaude] Forcing Claude Code effort support for ${primaryRealId}.`,
    )
  }

  // Step 7: Spawn claude
  spawnClaude(
    port,
    nonce,
    server,
    tokenManager.refreshTimer,
    true,
    effectiveCliOptions,
    yolo,
    telemetry,
    extraEnv,
  )
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
  extraEnv: Record<string, string> = {},
): void {
  const useAgency = cliOptions.useAgency
  const resolved = useAgency ? resolveAgencyBinary() : resolveClaudeBinary()

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

  if (!resolved) {
    console.error(
      `[proxyClaude] Could not resolve ${useAgency ? "agency" : "claude"} binary (checked PATH${useAgency ? "" : " and ~/.local/bin"}).`,
    )
    cleanup(1)
    return
  }

  const args = useAgency
    ? ["claude", ...cliOptions.passthroughArgs]
    : [...cliOptions.passthroughArgs]

  if (yolo) {
    args.push("--dangerously-skip-permissions")
    console.error("[proxyClaude] YOLO mode enabled — Claude will not ask for permissions!")
  }

  console.error(
    `[proxyClaude] Launching ${useAgency ? "agency claude" : "Claude Code"} (${resolved})...`,
  )

  // See src/spawn-utils.ts for the rationale: needsShellFor() returns true
  // only for Windows .cmd / .bat shims (which CVE-2024-27980 forces through
  // a shell), and quoteWindowsArg doubles `"` and `%` so cmd.exe does not
  // re-tokenize or env-expand user input on that path. Native .exe and Unix
  // binaries take the shell:false path where Node's libuv passes argv
  // through verbatim — that is the actual fix for the truncation bug.
  const needsShell = needsShellFor(resolved, process.platform)

  const spawnCommand = needsShell ? quoteWindowsArg(resolved) : resolved
  const spawnArgs = needsShell ? args.map(quoteWindowsArg) : args

  const child = spawn(spawnCommand, spawnArgs, {
    stdio: "inherit",
    shell: needsShell,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: nonce,
      ...extraEnv,
    },
  })

  child.on("exit", (code) => {
    cleanup(code ?? 0)
  })

  child.on("error", (err) => {
    console.error(`[proxyClaude] Failed to start ${resolved}:`, err.message)
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
