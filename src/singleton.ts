import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import os from "node:os"

import type { LockFileContent } from "./types.ts"

const LOCK_DIR = path.join(os.homedir(), ".proxy-claude")
const LOCK_FILE = path.join(LOCK_DIR, "server.lock")

// Bump this when server changes require a restart (e.g. new route handling)
const SERVER_VERSION = "6"

export function getServerVersion(): string {
  return SERVER_VERSION
}

export async function checkExistingInstance(
  _port: number,
): Promise<LockFileContent | null> {
  let lockInfo: LockFileContent
  try {
    const content = await fs.readFile(LOCK_FILE, "utf8")
    lockInfo = JSON.parse(content) as LockFileContent
  } catch {
    return null
  }

  try {
    process.kill(lockInfo.pid, 0)
  } catch {
    await removeLockFile()
    return null
  }

  try {
    const healthResult = await new Promise<{ responding: boolean; healthy: boolean }>((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${lockInfo.port}/`,
        { timeout: 2000 },
        (res) => {
          let body = ""
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString()
          })
          res.on("end", () => {
            try {
              const parsed = JSON.parse(body) as { status?: string }
              resolve({
                responding: true,
                healthy: parsed.status === "ok",
              })
            } catch {
              resolve({ responding: true, healthy: false })
            }
          })
        },
      )
      req.on("error", () => resolve({ responding: false, healthy: false }))
      req.on("timeout", () => {
        req.destroy()
        resolve({ responding: false, healthy: false })
      })
    })

    if (healthResult.responding && healthResult.healthy) {
      // If the lock file is from an older server version, kill it and start fresh
      if (lockInfo.version !== SERVER_VERSION) {
        console.error(
          `[proxyClaude] Existing server is outdated (v${lockInfo.version ?? "1"} → v${SERVER_VERSION}). Restarting...`,
        )
        try {
          process.kill(lockInfo.pid)
        } catch {
          // Process already gone
        }
        await removeLockFile()
        return null
      }
      return lockInfo
    }

    // Server is responding but token is unhealthy — kill it so we can start fresh
    if (healthResult.responding && !healthResult.healthy) {
      console.error(
        `[proxyClaude] Existing server (pid ${lockInfo.pid}) has an unhealthy token. Restarting...`,
      )
      try {
        process.kill(lockInfo.pid)
      } catch {
        // Process already gone
      }
    }
  } catch {
    // Server not responding
  }

  await removeLockFile()
  return null
}

export async function writeLockFile(info: LockFileContent): Promise<void> {
  await fs.mkdir(LOCK_DIR, { recursive: true, mode: 0o700 })
  await fs.writeFile(LOCK_FILE, JSON.stringify(info, null, 2))
  try {
    await fs.chmod(LOCK_FILE, 0o600)
  } catch {
    // Ignore on Windows where chmod is not meaningful
  }
}

export async function removeLockFile(): Promise<void> {
  try {
    await fs.unlink(LOCK_FILE)
  } catch {
    // Ignore — file may not exist
  }
}
