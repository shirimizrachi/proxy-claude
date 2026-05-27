import { appendFileSync, mkdirSync, chmodSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const PROXY_DIR = path.join(os.homedir(), ".proxy-claude")
const LOG_FILE = path.join(PROXY_DIR, "proxy.log")

let dirEnsured = false

/**
 * Append a timestamped line to ~/.proxy-claude/proxy.log.
 * Used for runtime logging that must NOT go to stderr (which is
 * inherited by the Claude Code child process).
 */
export function logToFile(message: string): void {
  try {
    if (!dirEnsured) {
      mkdirSync(PROXY_DIR, { recursive: true, mode: 0o700 })
      dirEnsured = true
    }
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 })
  } catch {
    // Logging must never break the proxy
  }
}

/** Format an error for file logging, preserving stack traces. */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }
  return String(error)
}
