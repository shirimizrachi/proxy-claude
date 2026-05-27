import fs from "node:fs/promises"
import { accessSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import readline from "node:readline"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import type { Model } from "./types.ts"
import { PROXY_CLAUDE_VERSION, UPDATE_CHECK_URL } from "./constants.ts"

const CLAUDE_DIR = path.join(os.homedir(), ".claude")
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json")
const PROXY_CLAUDE_DIR = path.join(os.homedir(), ".proxy-claude")
const UPDATE_CHECK_FILE = path.join(PROXY_CLAUDE_DIR, "update-check.json")
const REPO_PATH_FILE = path.join(PROXY_CLAUDE_DIR, "repo-path")

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(SETTINGS_FILE, "utf8")
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function writeSettings(
  settings: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(CLAUDE_DIR, { recursive: true })
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n")
  try {
    await fs.chmod(SETTINGS_FILE, 0o600)
  } catch {
    // Ignore on Windows where chmod is not meaningful
  }
}

export async function hasModelConfig(): Promise<boolean> {
  const settings = await readSettings()
  const env = settings.env as Record<string, string> | undefined
  return !!env?.ANTHROPIC_MODEL
}

export async function resetModelConfig(): Promise<void> {
  const settings = await readSettings()
  const env = (settings.env ?? {}) as Record<string, string>
  delete env.ANTHROPIC_MODEL
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete env.ANTHROPIC_SMALL_FAST_MODEL
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  settings.env = env
  await writeSettings(settings)
  console.error("[proxyClaude] Model config reset. You'll be prompted to pick again.")
}

export async function updateNonce(nonce: string, serverUrl?: string): Promise<void> {
  const settings = await readSettings()
  const env = (settings.env ?? {}) as Record<string, string>
  env.ANTHROPIC_AUTH_TOKEN = nonce
  if (serverUrl) {
    env.ANTHROPIC_BASE_URL = serverUrl
  }
  settings.env = env
  await writeSettings(settings)
}

export async function pickModel(
  models: Array<{ id: string; name: string }>,
  prompt: string,
  defaultIndex: number = 0,
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  console.error("")
  console.error(`  ${prompt}`)
  console.error("")
  models.forEach((m, i) => {
    console.error(`    ${i + 1}. ${m.id}`)
  })
  console.error("")

  return new Promise((resolve) => {
    rl.question(`  Choice [${defaultIndex + 1}]: `, (answer) => {
      rl.close()
      const trimmed = answer.trim()
      if (!trimmed) {
        resolve(models[defaultIndex].id)
        return
      }
      const index = parseInt(trimmed, 10) - 1
      if (index >= 0 && index < models.length) {
        resolve(models[index].id)
      } else {
        resolve(models[defaultIndex].id)
      }
    })
  })
}

export async function configureFirstRun(
  models: Array<Model> | Array<{ id: string; name: string }>,
  serverUrl: string,
  nonce: string,
): Promise<void> {
  console.error("[proxyClaude] First-time setup — select your models:")

  // Handle both full Model objects and simple {id, name} fallbacks
  const pickerModels = models.map((m) => {
    if ("model_picker_enabled" in m) {
      return m.model_picker_enabled ? { id: m.id, name: m.name } : null
    }
    return { id: m.id, name: m.name }
  }).filter((m): m is { id: string; name: string } => m !== null)

  if (pickerModels.length === 0) {
    console.error(
      "[proxyClaude] No models available for selection. Using defaults.",
    )
    return
  }

  const primaryModel = await pickModel(
    pickerModels,
    "Primary model (ANTHROPIC_MODEL)",
    0,
  )

  const smallModel = await pickModel(
    pickerModels,
    "Small/fast model (ANTHROPIC_SMALL_FAST_MODEL)",
    Math.min(3, pickerModels.length - 1),
  )

  // Append [1m] suffix for Claude Code's client-side context window recognition.
  // Model IDs like "claude-opus-4.6-1m" contain "1m" indicating 1M context support,
  // but Claude Code only recognizes the [1m] suffix to adjust its compaction threshold.
  // The suffix is stripped before sending the actual API request, so the proxy still
  // receives the original model ID.
  const withContextHint = (modelId: string): string =>
    modelId.includes("1m") ? `${modelId}[1m]` : modelId

  const settings = await readSettings()
  const env = (settings.env ?? {}) as Record<string, string>

  env.ANTHROPIC_BASE_URL = serverUrl
  env.ANTHROPIC_AUTH_TOKEN = nonce
  env.ANTHROPIC_MODEL = withContextHint(primaryModel)
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = withContextHint(primaryModel)
  env.ANTHROPIC_SMALL_FAST_MODEL = withContextHint(smallModel)
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = withContextHint(smallModel)
  env.DISABLE_NON_ESSENTIAL_MODEL_CALLS = "1"
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

  settings.env = env
  await writeSettings(settings)

  console.error(`[proxyClaude] Settings saved to ${SETTINGS_FILE}`)
}

function askYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      resolve(trimmed === "" || trimmed === "y" || trimmed === "yes")
    })
  })
}

function getClaudeFallbackPath(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".local", "bin", "claude.exe")
  }
  return path.join(os.homedir(), ".local", "bin", "claude")
}

function isClaudeInPath(): boolean {
  const checkCmd =
    process.platform === "win32" ? "where claude" : "which claude"
  try {
    execSync(checkCmd, { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

function isClaudeAtFallbackPath(): boolean {
  try {
    const fallbackPath = getClaudeFallbackPath()
    accessSync(fallbackPath)
    return true
  } catch {
    return false
  }
}

function getInstallCommand(): string {
  if (process.platform === "win32") {
    return "winget install Anthropic.ClaudeCode"
  }
  return "npm install -g @anthropic-ai/claude-code"
}

function getManualInstallInstructions(): string {
  if (process.platform === "win32") {
    return [
      "  To install manually, run:",
      "    winget install Anthropic.ClaudeCode",
    ].join("\n")
  }
  return [
    "  To install manually, run:",
    "    npm install -g @anthropic-ai/claude-code",
  ].join("\n")
}

export async function ensureClaudeCode(): Promise<void> {
  // Step 1: Check if claude is in PATH
  if (isClaudeInPath()) return

  // Step 2: Check fallback path (~/.local/bin/claude)
  if (isClaudeAtFallbackPath()) {
    const localBin = path.join("~", ".local", "bin")
    console.error(
      `[proxyClaude] Found 'claude' at ${getClaudeFallbackPath()} but it's not in your PATH.`,
    )
    console.error(`  Add ${localBin} to your PATH to avoid this warning.`)
    console.error("")
    return
  }

  // Step 3: Not found anywhere
  const installCmd = getInstallCommand()
  console.error("[proxyClaude] 'claude' command not found.")
  console.error("")
  console.error("  Claude Code is required but not installed.")
  console.error(`  Install command: ${installCmd}`)
  console.error("")

  const answer = await askYesNo("  Install now? [Y/n]: ")

  if (!answer) {
    console.error("")
    console.error(getManualInstallInstructions())
    console.error("")
    process.exit(1)
  }

  // Step 4: Run platform-specific installer
  console.error("[proxyClaude] Installing Claude Code...")
  try {
    execSync(installCmd, { stdio: "inherit" })
  } catch {
    console.error("[proxyClaude] Installation failed.")
    console.error(getManualInstallInstructions())
    process.exit(1)
  }

  // Step 5: Re-check — first try PATH, then fallback
  if (isClaudeInPath()) {
    console.error("[proxyClaude] Claude Code installed successfully.")
    return
  }

  if (isClaudeAtFallbackPath()) {
    const localBin = path.join("~", ".local", "bin")
    console.error("[proxyClaude] Claude Code installed successfully.")
    console.error(
      `  Note: 'claude' was installed to ${getClaudeFallbackPath()} but is not in your PATH.`,
    )
    console.error(
      `  Add ${localBin} to your PATH, or restart your terminal.`,
    )
    console.error("")
    return
  }

  // Step 6: Still not found
  console.error(
    "[proxyClaude] Installation completed but 'claude' command not found.",
  )
  console.error(
    "  You may need to add ~/.local/bin to your PATH or restart your terminal.",
  )
  process.exit(1)
}

export function ensureAgency(): void {
  const checkCmd =
    process.platform === "win32" ? "where agency" : "which agency"
  try {
    execSync(checkCmd, { stdio: "pipe" })
    return
  } catch {
    // Not found
  }

  console.error("[proxyClaude] 'agency' command not found.")
  console.error("")
  console.error("  The --agency flag requires the 'agency' CLI.")
  console.error(
    "  Install: https://eng.ms/docs/coreai/devdiv/one-engineering-system-1es/1es-jacekcz/startrightgitops/agency/installation/install-agency?tabs=windows",
  )
  console.error("")
  process.exit(1)
}

export function isNewerVersion(remote: string, local: string): boolean {
  const rParts = remote.split(".").map(Number)
  const lParts = local.split(".").map(Number)
  for (let i = 0; i < Math.max(rParts.length, lParts.length); i++) {
    const r = rParts[i] ?? 0
    const l = lParts[i] ?? 0
    if (r > l) return true
    if (r < l) return false
  }
  return false
}

/**
 * If the current binary is running from a git clone, save the repo root path
 * to ~/.proxy-claude/repo-path. This lets `proxy-claude update` find the
 * original clone even when running from a global npm install.
 */
export async function saveRepoPath(): Promise<void> {
  try {
    const __filename = fileURLToPath(import.meta.url)
    const repoRoot = path.resolve(path.dirname(__filename), "..")
    await fs.access(path.join(repoRoot, ".git"))
    // We're in a git clone — persist the path
    await fs.mkdir(PROXY_CLAUDE_DIR, { recursive: true, mode: 0o700 })
    await fs.writeFile(REPO_PATH_FILE, repoRoot)
  } catch {
    // Not a git repo or write failed — skip
  }
}

/**
 * Resolve the git repo root to use for updates. Checks:
 * 1. Current binary location (running directly from clone)
 * 2. Saved repo path from ~/.proxy-claude/repo-path (global npm install from clone)
 * Returns null if no valid git repo is found.
 */
async function resolveGitRepoRoot(): Promise<string | null> {
  const __filename = fileURLToPath(import.meta.url)
  const binaryRoot = path.resolve(path.dirname(__filename), "..")

  // Check if the binary itself lives in a git repo
  try {
    await fs.access(path.join(binaryRoot, ".git"))
    return binaryRoot
  } catch {
    // Not a git repo at the binary location
  }

  // Check for a previously saved repo path
  try {
    const savedPath = (await fs.readFile(REPO_PATH_FILE, "utf8")).trim()
    if (savedPath) {
      await fs.access(path.join(savedPath, ".git"))
      return savedPath
    }
  } catch {
    // No saved path or it's stale
  }

  return null
}

export async function checkForUpdates(): Promise<void> {
  try {
    // Check throttle — at most once per 24 hours
    try {
      const checkData = await fs.readFile(UPDATE_CHECK_FILE, "utf8")
      const { lastCheck } = JSON.parse(checkData) as { lastCheck: number }
      if (Date.now() - lastCheck < ONE_DAY_MS) return
    } catch {
      // No file or invalid — proceed with check
    }

    // Read saved GitHub token for authenticated API access (repo is private/internal)
    let authHeaders: Record<string, string> = {}
    try {
      const savedToken = (await fs.readFile(path.join(PROXY_CLAUDE_DIR, "github_token"), "utf8")).trim()
      if (savedToken) {
        authHeaders = { authorization: `token ${savedToken}` }
      }
    } catch {
      // No saved token — try unauthenticated (will fail for private repos)
    }

    // Fetch remote package.json via GitHub API (supports private/internal repos)
    const res = await fetch(UPDATE_CHECK_URL, {
      headers: {
        accept: "application/vnd.github.v3.raw",
        "user-agent": "proxyClaude",
        ...authHeaders,
      },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return

    const pkg = (await res.json()) as { version?: string }
    const remoteVersion = pkg.version
    if (!remoteVersion) return

    // Save check timestamp regardless of result
    await fs.mkdir(PROXY_CLAUDE_DIR, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      UPDATE_CHECK_FILE,
      JSON.stringify({ lastCheck: Date.now() }),
    )

    if (!isNewerVersion(remoteVersion, PROXY_CLAUDE_VERSION)) return

    // Derive repo root from the built script location: <repo>/dist/main.js → <repo>
    const __filename = fileURLToPath(import.meta.url)
    const repoRoot = path.resolve(path.dirname(__filename), "..")

    // Verify it's a git repo
    try {
      await fs.access(path.join(repoRoot, ".git"))
    } catch {
      // Not a git repo (e.g. copied dist/main.js elsewhere) — just notify
      console.error(
        `[proxyClaude] Update available: ${PROXY_CLAUDE_VERSION} → ${remoteVersion}`,
      )
      return
    }

    // Notify user about available update (never auto-execute remote code)
    console.error(
      `[proxyClaude] Update available: ${PROXY_CLAUDE_VERSION} → ${remoteVersion}`,
    )
    console.error(
      `[proxyClaude] To update, run: cd ${repoRoot} && git pull && npm install && npm run build`,
    )
  } catch {
    // Never block startup — silently ignore any update check failures
  }
}

/**
 * Perform the `proxy-claude update` command — pulls latest code and rebuilds.
 * Skips version comparison: when the user explicitly asks to update, always
 * pull the latest. The version check is only used by the passive background
 * notification in checkForUpdates().
 */
export async function performUpdate(): Promise<void> {
  console.error(`[proxyClaude] Current version: v${PROXY_CLAUDE_VERSION}`)
  console.error("[proxyClaude] Pulling latest changes...")

  // Find the git repo root (either current location or saved path from global install)
  const repoRoot = await resolveGitRepoRoot()

  if (repoRoot) {
    // Persist repo path so future updates from global installs can find it
    try {
      await fs.mkdir(PROXY_CLAUDE_DIR, { recursive: true, mode: 0o700 })
      await fs.writeFile(REPO_PATH_FILE, repoRoot)
    } catch {
      // Non-critical
    }

    console.error(`[proxyClaude] Updating via git pull (${repoRoot})...`)
    try {
      execSync("git pull", { cwd: repoRoot, stdio: "inherit" })
      execSync("npm install", { cwd: repoRoot, stdio: "inherit" })
      execSync("npm run build", { cwd: repoRoot, stdio: "inherit" })
    } catch {
      console.error("[proxyClaude] Update failed.")
      console.error(
        `[proxyClaude] Try manually: cd ${repoRoot} && git pull && npm install && npm run build`,
      )
      process.exit(1)
    }

    // If we're NOT running from the repo directly, re-install globally
    const __filename = fileURLToPath(import.meta.url)
    const binaryRoot = path.resolve(path.dirname(__filename), "..")
    if (binaryRoot !== repoRoot) {
      console.error("[proxyClaude] Re-installing global package...")
      try {
        execSync("npm install -g .", { cwd: repoRoot, stdio: "inherit" })
      } catch {
        console.error("[proxyClaude] Global re-install failed.")
        console.error(
          `[proxyClaude] Try manually: cd ${repoRoot} && npm install -g .`,
        )
        process.exit(1)
      }
    }
  } else {
    console.error("[proxyClaude] Cannot find a git clone to update from.")
    console.error(
      "[proxyClaude] Clone the repo and run from there, or use: git clone https://github.com/aep-edge-microsoft/proxy-claude.git && cd proxy-claude && npm install && npx proxy-claude",
    )
    process.exit(1)
  }

  // Update the throttle timestamp so the background check doesn't re-trigger
  try {
    await fs.mkdir(PROXY_CLAUDE_DIR, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      UPDATE_CHECK_FILE,
      JSON.stringify({ lastCheck: Date.now() }),
    )
  } catch {
    // Non-critical
  }

  console.error(`[proxyClaude] Updated successfully.`)
}

const STATUSLINE_FILENAME = "statusline.js"
const STATUSLINE_DEST = path.join(CLAUDE_DIR, STATUSLINE_FILENAME)

/**
 * Install the statusline script to ~/.claude/statusline.js and configure
 * the statusLine setting in ~/.claude/settings.json.
 *
 * - Copies src/statusline.js (bundled alongside dist/main.js) to ~/.claude/
 * - Adds the statusLine setting with the proper absolute path for the user
 * - Idempotent: overwrites the script each time (picks up updates),
 *   but preserves any other settings in settings.json
 */
export async function installStatusLine(): Promise<void> {
  try {
    // Locate the bundled statusline.js relative to the running script.
    // In dev: src/statusline.js sits next to src/config.ts
    // In build: dist/statusline.js should sit next to dist/main.js
    const __filename = fileURLToPath(import.meta.url)
    const srcScript = path.join(path.dirname(__filename), STATUSLINE_FILENAME)

    // Copy to ~/.claude/statusline.js (create dir if needed)
    await fs.mkdir(CLAUDE_DIR, { recursive: true })
    await fs.copyFile(srcScript, STATUSLINE_DEST)

    // Build the command with the user's absolute path.
    // Use forward slashes even on Windows — Node handles both, and it avoids
    // JSON escaping issues with backslashes.
    const scriptPath = STATUSLINE_DEST.replace(/\\/g, "/")
    const command = `node ${scriptPath}`

    // Merge into settings.json (read-modify-write)
    const settings = await readSettings()
    settings.statusLine = {
      type: "command",
      command,
      padding: 1,
    }
    await writeSettings(settings)

    console.error(`[proxyClaude] Status line installed → ${STATUSLINE_DEST}`)
  } catch {
    // Non-critical — don't block startup if statusline install fails
    console.error("[proxyClaude] Could not install status line (non-fatal).")
  }
}
