import fs from "node:fs/promises"
import { accessSync, statSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import readline from "node:readline"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import type { Model, ModelAliasFile } from "./types.ts"
import { PROXY_CLAUDE_VERSION, UPDATE_CHECK_URL } from "./constants.ts"
import { ghcpIdToAlias } from "./translate.ts"

const CLAUDE_DIR = path.join(os.homedir(), ".claude")
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json")
const PROXY_CLAUDE_DIR = path.join(os.homedir(), ".proxy-claude")
const UPDATE_CHECK_FILE = path.join(PROXY_CLAUDE_DIR, "update-check.json")
const REPO_PATH_FILE = path.join(PROXY_CLAUDE_DIR, "repo-path")
const MODEL_ALIAS_FILE = path.join(PROXY_CLAUDE_DIR, "model-aliases.json")

const ONE_DAY_MS = 24 * 60 * 60 * 1000

// Shared ANSI escapes for the interactive prompts in this module, so the
// same literals aren't redeclared in every picker function.
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
} as const

/** Env key holding the minimum reasoning-effort floor; "auto"/undefined = unset. */
const EFFORT_FLOOR_ENV = "PROXY_CLAUDE_MIN_EFFORT"

/**
 * Single source of truth for writing the effort floor into a settings env
 * block. "auto" (or undefined) is the sentinel for "no floor" and deletes the
 * key; any other value is written verbatim. Owns both the key name and the
 * auto-is-unset convention so the three writers can't drift.
 */
export function setEffortFloor(
  env: Record<string, string>,
  value: string | undefined,
): void {
  if (!value || value === "auto") {
    delete env[EFFORT_FLOOR_ENV]
  } else {
    env[EFFORT_FLOOR_ENV] = value
  }
}

/** One row of the model picker, used by both the interactive and numeric paths. */
function renderPickerRow(
  m: { id: string; name: string; badge?: string },
  i: number,
  selected: number,
  labelWidth: number,
): string {
  const isSelected = i === selected
  const marker = isSelected ? `${ANSI.cyan}❯${ANSI.reset}` : " "
  const num = `${i + 1}.`.padStart(3, " ")
  const label = m.name || m.id
  const padded = label.padEnd(labelWidth, " ")
  const colored = isSelected ? `${ANSI.cyan}${padded}${ANSI.reset}` : padded
  const badge = m.badge ? `  ${ANSI.magenta}${m.badge}${ANSI.reset}` : ""
  return `  ${marker} ${num} ${colored}${badge}`
}

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
  setEffortFloor(env, undefined)
  settings.env = env
  await writeSettings(settings)
  console.error(`[proxyClaude] ${ANSI.yellow}↺${ANSI.reset} Model + effort config cleared. You'll be prompted to pick again.`)
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
  models: Array<{ id: string; name: string; badge?: string }>,
  prompt: string,
  defaultIndex: number = 0,
): Promise<string> {
  // Compute the widest label so badges align in a column.
  const labelWidth = Math.max(
    ...models.map((m) => (m.name || m.id).length),
  )

  // Use interactive arrow-key navigation only when stderr (where we render)
  // AND stdin (where we read) are both TTYs and the platform supports raw
  // mode. Otherwise fall back to the line-based numeric picker so piped
  // input, CI logs, and dumb terminals still work.
  const canUseRawMode =
    typeof process.stdin.setRawMode === "function" &&
    process.stdin.isTTY === true &&
    process.stderr.isTTY === true

  console.error("")
  console.error(`  ${ANSI.bold}${prompt}${ANSI.reset}`)
  console.error("")

  return canUseRawMode
    ? interactivePickModel(models, defaultIndex, labelWidth)
    : numericPickModel(models, defaultIndex, labelWidth)
}

/**
 * Interactive picker with up/down arrow navigation, vim-style j/k, digit
 * jump (1-9), Enter to confirm, Esc/Ctrl+C to abort.
 *
 * Re-renders in place by moving the cursor up over the previously-drawn rows
 * and clearing each line before re-drawing. Trailing newline is printed once
 * confirmation arrives so subsequent log output doesn't overwrite the list.
 */
function interactivePickModel(
  models: Array<{ id: string; name: string; badge?: string }>,
  defaultIndex: number,
  labelWidth: number,
): Promise<string> {
  let selected = Math.max(0, Math.min(defaultIndex, models.length - 1))
  const stdin = process.stdin
  const stderr = process.stderr

  const draw = (firstDraw: boolean) => {
    if (!firstDraw) {
      // Move cursor up by (rows + hint line) and clear each line as we go.
      // Hint line is one row.
      const rowsToClear = models.length + 1
      for (let i = 0; i < rowsToClear; i++) {
        stderr.write("\x1b[1A\x1b[2K")
      }
    }
    for (let i = 0; i < models.length; i++) {
      stderr.write(renderPickerRow(models[i], i, selected, labelWidth) + "\n")
    }
    stderr.write(`  ${ANSI.dim}↑/↓ to navigate · Enter to select · 1-${Math.min(9, models.length)} to jump${ANSI.reset}\n`)
  }

  return new Promise<string>((resolve) => {
    readline.emitKeypressEvents(stdin)
    const wasRaw = stdin.isRaw === true
    try {
      stdin.setRawMode(true)
    } catch {
      // Setting raw mode can fail on some platforms; fall back gracefully.
    }
    stdin.resume()

    const cleanup = () => {
      stdin.removeListener("keypress", onKeypress)
      try {
        stdin.setRawMode(wasRaw)
      } catch {
        // ignore
      }
      stdin.pause()
    }

    const onKeypress = (
      _str: string | undefined,
      key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
    ) => {
      if (!key) return

      // Ctrl+C / Ctrl+D — abort with default
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        cleanup()
        // Move past the picker before exiting so the next output isn't tangled
        stderr.write("\n")
        process.exit(130)
      }

      if (key.name === "up" || key.name === "k") {
        if (selected > 0) {
          selected--
          draw(false)
        }
        return
      }

      if (key.name === "down" || key.name === "j") {
        if (selected < models.length - 1) {
          selected++
          draw(false)
        }
        return
      }

      if (key.name === "home") {
        selected = 0
        draw(false)
        return
      }
      if (key.name === "end") {
        selected = models.length - 1
        draw(false)
        return
      }

      // Digit jump: 1-9 select that row directly when in range.
      if (key.sequence && /^[1-9]$/.test(key.sequence)) {
        const idx = parseInt(key.sequence, 10) - 1
        if (idx < models.length) {
          selected = idx
          draw(false)
        }
        return
      }

      if (key.name === "return" || key.name === "enter") {
        cleanup()
        resolve(models[selected].id)
        return
      }
    }

    stdin.on("keypress", onKeypress)
    draw(true)
  })
}

/**
 * Fallback picker for non-TTY environments. Same numeric prompt as before:
 * print rows once with the default highlighted, read a single line, parse a
 * 1-based index. Empty input → default.
 */
function numericPickModel(
  models: Array<{ id: string; name: string; badge?: string }>,
  defaultIndex: number,
  labelWidth: number,
): Promise<string> {
  models.forEach((m, i) => {
    console.error(renderPickerRow(m, i, defaultIndex, labelWidth))
  })
  console.error("")

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  return new Promise((resolve) => {
    rl.question(`  ${ANSI.dim}Choice [${defaultIndex + 1}]:${ANSI.reset} `, (answer) => {
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

/**
 * Three-way maps connecting Claude-Code-recognizable aliases and real GHCP
 * model ids. See ghcpIdToAlias() for the alias rule.
 */
export interface AliasMaps {
  /** alias → real GHCP id (e.g. "claude-opus-4-7" → "claude-opus-4.7-1m-internal") */
  aliasToReal: Map<string, string>
  /** real GHCP id → alias (e.g. "claude-opus-4.7-1m-internal" → "claude-opus-4-7") */
  realToAlias: Map<string, string>
  /** real GHCP id → whether the model has 1M context. Used to compute the
   *  [1m] hint in settings ids, decoupled from any "1m" segments in aliases. */
  realHas1m: Map<string, boolean>
}

export function emptyAliasMaps(): AliasMaps {
  return {
    aliasToReal: new Map(),
    realToAlias: new Map(),
    realHas1m: new Map(),
  }
}

/**
 * Build alias maps from a /models response.
 *
 * Collision policy: when multiple real GHCP ids would produce the same alias
 * (e.g. claude-opus-4.7-1m-internal, claude-opus-4.7-high, claude-opus-4.7
 * all → "claude-opus-4-7"), we prefer the unique 1M-context variant as the
 * canonical alias winner. The losing ids are still usable from the picker
 * but pass through as raw ids (no alias rewrite). If there is no unique 1m
 * winner — e.g. zero 1m variants, or two or more 1m variants — the entire
 * collision group is dropped from the alias map to avoid silently routing
 * to the wrong model.
 *
 * has1m is determined by TWO signals (either is sufficient):
 *   1. The model id suffix contains "1m" (legacy GHCP naming like
 *      "claude-opus-4.7-1m-internal")
 *   2. capabilities.limits.max_context_window_tokens >= 1,000,000
 *      (modern GHCP catalog where base models natively support 1M)
 *
 * See docs/MODEL-ALIASING.md for the rationale and worked examples.
 */
export function buildAliasMaps(
  models: ReadonlyArray<{ id: string; capabilities?: { limits?: { max_context_window_tokens?: number } } }>,
): AliasMaps {
  const maps = emptyAliasMaps()

  // First pass: collect all alias candidates and detect collisions.
  // aliasCandidates: alias -> list of real ids that want that alias.
  const aliasCandidates = new Map<string, string[]>()
  const realToHas1m = new Map<string, boolean>()

  for (const m of models) {
    if (!m.id) continue
    const result = ghcpIdToAlias(m.id)
    if (!result) continue
    // Two sources for has1m: suffix regex OR capabilities context window.
    const suffixHas1m = result.has1m
    const capsHas1m = (m.capabilities?.limits?.max_context_window_tokens ?? 0) >= 1_000_000
    realToHas1m.set(m.id, suffixHas1m || capsHas1m)
    const existing = aliasCandidates.get(result.alias) ?? []
    existing.push(m.id)
    aliasCandidates.set(result.alias, existing)
  }

  // Second pass: resolve collisions by preferring the unique 1m variant.
  for (const [alias, reals] of aliasCandidates) {
    let winner: string | undefined
    if (reals.length === 1) {
      winner = reals[0]
    } else {
      const oneMs = reals.filter((r) => realToHas1m.get(r) === true)
      if (oneMs.length === 1) {
        winner = oneMs[0]
        const losers = reals.filter((r) => r !== winner)
        console.error(
          `[proxyClaude] Alias collision on "${alias}": preferred 1M variant ${winner}; raw ids for ${losers.join(", ")}.`,
        )
      } else {
        console.error(
          `[proxyClaude] Alias collision on "${alias}": no unique 1M variant among ${reals.join(", ")}. All will use raw ids.`,
        )
        continue
      }
    }
    maps.aliasToReal.set(alias, winner)
    maps.realToAlias.set(winner, alias)
    maps.realHas1m.set(winner, realToHas1m.get(winner) ?? false)
  }

  return maps
}

/**
 * Produce the string that goes into ~/.claude/settings.json for a given real
 * GHCP id, using the provided alias maps. Returns the alias (with optional
 * [1m] hint) when an alias exists, otherwise the raw id (with optional [1m]
 * hint inferred from the id).
 *
 * Idempotent and safe even when the alias itself contains "1m" segments —
 * the [1m] flag is keyed off the real id, not the alias string.
 */
export function realIdToSettingsId(realId: string, maps: AliasMaps): string {
  const alias = maps.realToAlias.get(realId)
  if (alias !== undefined) {
    const has1m = maps.realHas1m.get(realId) ?? false
    return has1m ? `${alias}[1m]` : alias
  }
  // No alias known — fall back to the legacy heuristic (preserves behavior for
  // non-Claude or already-canonical ids).
  return realId.includes("1m") ? `${realId}[1m]` : realId
}

/** Persist the current alias map to ~/.proxy-claude/model-aliases.json. */
export async function saveAliasMap(maps: AliasMaps): Promise<void> {
  try {
    await fs.mkdir(PROXY_CLAUDE_DIR, { recursive: true, mode: 0o700 })
    const file: ModelAliasFile = {
      version: 1,
      savedAt: Date.now(),
      aliases: Object.fromEntries(maps.aliasToReal),
    }
    await fs.writeFile(MODEL_ALIAS_FILE, JSON.stringify(file, null, 2), { mode: 0o600 })
  } catch {
    // Non-critical — alias map is a fallback for /models fetch failures.
  }
}

/**
 * Load a previously persisted alias map. Returns an empty AliasMaps on miss
 * or corruption — callers should treat that as "alias resolution disabled".
 *
 * Note: the persisted file has aliases only (no real-id has1m flag). We
 * re-derive has1m from the real id at load time, which matches what
 * buildAliasMaps() does for fresh data.
 */
export async function loadAliasMap(): Promise<AliasMaps> {
  try {
    const raw = await fs.readFile(MODEL_ALIAS_FILE, "utf8")
    const parsed = JSON.parse(raw) as ModelAliasFile
    if (parsed.version !== 1 || typeof parsed.aliases !== "object") {
      return emptyAliasMaps()
    }
    const maps = emptyAliasMaps()
    for (const [alias, real] of Object.entries(parsed.aliases)) {
      maps.aliasToReal.set(alias, real)
      maps.realToAlias.set(real, alias)
      const aliasResult = ghcpIdToAlias(real)
      maps.realHas1m.set(real, aliasResult?.has1m ?? false)
    }
    return maps
  } catch {
    return emptyAliasMaps()
  }
}

export async function configureFirstRun(
  models: Array<Model> | Array<{ id: string; name: string }>,
  serverUrl: string,
  nonce: string,
  aliasMaps: AliasMaps = emptyAliasMaps(),
): Promise<void> {
  const { dim, reset, bold, cyan, green } = ANSI

  console.error("")
  console.error(`  ${bold}╭─ proxy-claude setup ─────────────────────────────╮${reset}`)
  console.error(`  ${bold}│${reset}                                                   ${bold}│${reset}`)
  console.error(`  ${bold}│${reset}  Configure which models Claude Code will use.     ${bold}│${reset}`)
  console.error(`  ${bold}│${reset}  You can change these later with ${cyan}--reset-models${reset}  ${bold}│${reset}`)
  console.error(`  ${bold}│${reset}  or ${cyan}--effort=max${reset}.                                ${bold}│${reset}`)
  console.error(`  ${bold}│${reset}                                                   ${bold}│${reset}`)
  console.error(`  ${bold}╰───────────────────────────────────────────────────╯${reset}`)
  console.error("")

  // Handle both full Model objects and simple {id, name} fallbacks
  const pickerModels = models.map((m) => {
    const hasCapabilities = "capabilities" in m
    if ("model_picker_enabled" in m && !m.model_picker_enabled) {
      return null
    }
    // Build a badge string from capabilities so users can see context window
    // and reasoning effort support at a glance in the picker.
    let badge: string | undefined
    if (hasCapabilities && m.capabilities) {
      const parts: string[] = []
      const ctx = m.capabilities.limits?.max_context_window_tokens
      if (ctx) {
        if (ctx >= 1_000_000) parts.push("1M ctx")
        else if (ctx >= 1_000) parts.push(`${Math.round(ctx / 1000)}k ctx`)
      }
      const efforts = m.capabilities.supports?.reasoning_effort
      if (efforts && efforts.length > 0) {
        parts.push(`thinking: ${efforts[efforts.length - 1]}`)
      }
      if (parts.length > 0) badge = `· ${parts.join(" · ")}`
    }
    return { id: m.id, name: m.name, badge }
  }).filter((m): m is { id: string; name: string; badge: string | undefined } => m !== null)

  if (pickerModels.length === 0) {
    console.error(
      "[proxyClaude] No models available for selection. Using defaults.",
    )
    return
  }

  console.error(`  ${dim}Step 1/3${reset}`)
  const primaryModel = await pickModel(
    pickerModels,
    "Primary model — used for all main requests",
    0,
  )
  console.error(`  ${green}✓${reset} ${dim}Primary:${reset} ${primaryModel}`)

  console.error("")
  console.error(`  ${dim}Step 2/3${reset}`)
  const smallModel = await pickModel(
    pickerModels,
    "Background model — used for quick tasks & summaries",
    Math.min(3, pickerModels.length - 1),
  )
  console.error(`  ${green}✓${reset} ${dim}Background:${reset} ${smallModel}`)

  // Effort floor picker
  console.error("")
  console.error(`  ${dim}Step 3/3${reset}`)
  const effortChoices = [
    { id: "auto", name: "auto — Claude Code decides per-task" },
    { id: "high", name: "high — never below high effort" },
    { id: "max", name: "max  — always maximum reasoning" },
  ]
  const effortChoice = await pickModel(
    effortChoices,
    "Reasoning effort — minimum thinking effort per request",
    0,
  )
  console.error(`  ${green}✓${reset} ${dim}Effort floor:${reset} ${effortChoice}`)

  // Write the settings id (alias + optional [1m]) to ~/.claude/settings.json
  // so Claude Code's substring matchers recognize the model family/version.
  // The proxy resolves the alias back to the real GHCP id on every request.
  const toSettingsId = (modelId: string): string =>
    realIdToSettingsId(modelId, aliasMaps)

  const settings = await readSettings()
  const env = (settings.env ?? {}) as Record<string, string>

  env.ANTHROPIC_BASE_URL = serverUrl
  env.ANTHROPIC_AUTH_TOKEN = nonce
  env.ANTHROPIC_MODEL = toSettingsId(primaryModel)
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = toSettingsId(primaryModel)
  env.ANTHROPIC_SMALL_FAST_MODEL = toSettingsId(smallModel)
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = toSettingsId(smallModel)
  env.DISABLE_NON_ESSENTIAL_MODEL_CALLS = "1"
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

  setEffortFloor(env, effortChoice)

  settings.env = env
  await writeSettings(settings)

  console.error("")
  console.error(`  ${green}Done!${reset} Settings saved to ${dim}${SETTINGS_FILE}${reset}`)
  console.error("")
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

/**
 * Resolve the absolute path of an executable on PATH. Returns null when not
 * found. Uses `where` (Windows) / `which` (Unix) and takes the first matching
 * line, which preserves OS PATH precedence and — critically on Windows —
 * returns the precise extension (.exe vs .cmd vs .ps1) so the caller can
 * decide whether a shell wrapper is required to spawn it.
 *
 * `name` is interpolated into a shell command (cmd.exe / sh), so it is
 * restricted to a conservative allowlist (letters, digits, dot, dash,
 * underscore) to prevent shell metacharacter injection. Returns null for any
 * name that doesn't match. The allowlist is intentionally narrower than the
 * set of legal executable names — binaries like `clang++` or `g++` would be
 * rejected, but the proxy only ever resolves the known-safe names "claude"
 * and "agency", so the tradeoff favors safety over generality. Widen the
 * regex if new callers need additional characters.
 */
const SAFE_BINARY_NAME = /^[A-Za-z0-9._-]+$/

export function isSafeBinaryName(name: string): boolean {
  return SAFE_BINARY_NAME.test(name)
}

/**
 * Parse `where`/`which` stdout into the first usable path. Splits on CRLF or
 * LF, trims, drops blanks, then drops paths whose file size is 0 (Windows
 * App Execution Alias reparse points under WindowsApps that `where` returns
 * but cannot be spawned — they fail with a confusing ENOENT/UNKNOWN).
 *
 * Pure for testability: callers inject a `sizeOf(path)` function. Production
 * uses statSync; tests pass a stub.
 *
 * Returns null when no entry remains after filtering.
 */
export function parseWhichOutput(
  stdout: string,
  sizeOf: (p: string) => number | null,
): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => {
      const size = sizeOf(p)
      return size !== null && size > 0
    })
  return lines[0] ?? null
}

export function resolveBinaryOnPath(name: string): string | null {
  if (!isSafeBinaryName(name)) return null
  const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`
  try {
    const stdout = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString()
    return parseWhichOutput(stdout, (p) => {
      try {
        return statSync(p).size
      } catch {
        return null
      }
    })
  } catch {
    return null
  }
}

function isClaudeInPath(): boolean {
  return resolveBinaryOnPath("claude") !== null
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

/**
 * Resolve the Claude Code binary to an absolute path. Checks PATH first
 * (winget / npm global / Homebrew installs all land here), then the
 * documented fallback ~/.local/bin/claude(.exe). Returns null when not found;
 * callers should run ensureClaudeCode() before relying on a non-null result.
 */
export function resolveClaudeBinary(): string | null {
  const onPath = resolveBinaryOnPath("claude")
  if (onPath) return onPath
  if (isClaudeAtFallbackPath()) return getClaudeFallbackPath()
  return null
}

/** Same shape as resolveClaudeBinary, but for the agency wrapper. */
export function resolveAgencyBinary(): string | null {
  return resolveBinaryOnPath("agency")
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

export function ensureAgency(): boolean {
  const checkCmd =
    process.platform === "win32" ? "where agency" : "which agency"
  try {
    execSync(checkCmd, { stdio: "pipe" })
    return true
  } catch {
    // Not found
  }

  console.error(
    "[proxyClaude] 'agency' command not found, falling back to launching Claude Code directly.",
  )
  return false
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
 * Decide whether a repo on `branch` with the given working-tree dirty state
 * is safe to auto-update via `git pull`. Returns null when safe, otherwise an
 * error message describing why the update is blocked.
 *
 * Exported for unit testing — performUpdate composes this with execSync calls.
 */
export function describeUpdateBlock(
  branch: string,
  dirty: boolean,
): string | null {
  if (branch !== "main" && branch !== "master") {
    return `Update source is on branch '${branch}', not 'main'. Refusing to auto-update.`
  }
  if (dirty) {
    return `Update source has uncommitted changes. Refusing to auto-update.`
  }
  return null
}

/**
 * Run `proxy-claude update` — pull latest source, rebuild, and (if installed
 * globally) re-link the global binary.
 *
 * Refuses if the update source repo isn't on main/master or has uncommitted
 * changes, to avoid silently pulling into a dev branch (see #?? for the bug
 * this guards against: a global install whose saved repo path pointed at a
 * dev branch silently did `git pull <devbranch>`, picking up no updates).
 *
 * Skips the "Update available" prompt: we already showed that as a passive
 * notification in checkForUpdates().
 */
export async function performUpdate(): Promise<void> {
  console.error(`[proxyClaude] Current version: v${PROXY_CLAUDE_VERSION}`)
  console.error("[proxyClaude] Pulling latest changes...")

  // Find the git repo root (either current location or saved path from global install)
  const repoRoot = await resolveGitRepoRoot()

  if (repoRoot) {
    // Safety gate: refuse to update when the source repo isn't on main/master
    // or has uncommitted changes. A naive `git pull` on a dev branch is the
    // most common way for users to silently end up with stale binaries.
    let branch: string
    let dirty: boolean
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: repoRoot,
      }).toString().trim()
      dirty = execSync("git status --porcelain", {
        cwd: repoRoot,
      }).toString().trim().length > 0
    } catch {
      console.error(
        `[proxyClaude] Could not inspect git state at ${repoRoot}. Refusing to auto-update.`,
      )
      console.error(
        `[proxyClaude] Try manually: cd ${repoRoot} && git status`,
      )
      process.exit(1)
    }

    const block = describeUpdateBlock(branch, dirty)
    if (block) {
      console.error(`[proxyClaude] ${block}`)
      console.error(`[proxyClaude] Update source: ${repoRoot}`)
      console.error(`[proxyClaude] To unblock, either:`)
      console.error(
        `[proxyClaude]   • cd ${repoRoot} && git checkout main && git pull && npm install -g .`,
      )
      console.error(
        `[proxyClaude]   • Or clone a fresh copy somewhere else and install from there:`,
      )
      console.error(
        `[proxyClaude]       git clone https://github.com/aep-edge-microsoft/proxy-claude.git /tmp/proxy-claude-update \\`,
      )
      console.error(
        `[proxyClaude]         && cd /tmp/proxy-claude-update && npm install && npm install -g .`,
      )
      console.error(
        `[proxyClaude]   Then delete the stale saved path: rm ${REPO_PATH_FILE}`,
      )
      process.exit(1)
    }

    // Persist repo path so future updates from global installs can find it
    try {
      await fs.mkdir(PROXY_CLAUDE_DIR, { recursive: true, mode: 0o700 })
      await fs.writeFile(REPO_PATH_FILE, repoRoot)
    } catch {
      // Non-critical
    }

    console.error(`[proxyClaude] Updating via git pull (${repoRoot}, branch ${branch})...`)
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
