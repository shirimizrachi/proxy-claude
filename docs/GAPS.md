# Gap Analysis & Missing Implementation Details

This document fills in gaps identified after reviewing the design docs — things an implementer
would need to figure out on their own without this information.

---

## Gap 1: Environment Variable Names (CRITICAL)

There is a discrepancy between the GHCP SDK and CLI modes:

| Mode | Variable | Header Sent |
|------|----------|-------------|
| SDK agent (`claudeCodeAgent.ts`) | `ANTHROPIC_API_KEY` | `x-api-key: <nonce>` |
| CLI terminal (`terminalCommand.ts`) | `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer <nonce>` |
| copilot-api `--claude-code` | `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer <nonce>` |

**Decision: Use `ANTHROPIC_AUTH_TOKEN`** — we're spawning the Claude Code CLI, not using the SDK.

The server must validate **both** header formats (as GHCP does) for forward compatibility:
```typescript
function isAuthValid(req: http.IncomingMessage, nonce: string): boolean {
  // Check x-api-key header (SDK mode)
  const apiKey = req.headers["x-api-key"];
  if (apiKey === nonce) return true;

  // Check Authorization: Bearer header (CLI mode)
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7) === nonce;
  }

  return false;
}
```

**Environment variables to pass to `claude` child process:**
```typescript
env: {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_AUTH_TOKEN: nonce,  // NOT "dummy" — use actual nonce for security
}
```

**Settings written to `~/.claude/settings.json`:**
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141",
    "ANTHROPIC_AUTH_TOKEN": "<nonce>",
    "ANTHROPIC_MODEL": "<selected>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<selected>",
    "ANTHROPIC_SMALL_FAST_MODEL": "<small>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<small>",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Note: `ANTHROPIC_AUTH_TOKEN` in settings.json will be stale across restarts (nonce changes).
The env vars passed directly to the child process override settings.json, so this is fine —
the settings.json is mainly for users who want to run `claude` manually without proxyClaude.

---

## Gap 2: GitHub User API (Missing from Reference Source)

The auth flow needs to display "Logged in as X". This requires a GitHub user API call.

**Add to `src/auth.ts`:**
```typescript
async function getGitHubUser(githubToken: string): Promise<string> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      authorization: `token ${githubToken}`,
      ...standardHeaders(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get GitHub user: ${response.status}`);
  }

  const json = await response.json() as { login: string };
  return json.login;
}
```

---

## Gap 3: SSE Parser Implementation

The `copilot-api` uses `fetch-event-stream` for SSE parsing. We need our own since we have zero deps.

**Add to `src/copilot.ts`:**
```typescript
/**
 * Parse Server-Sent Events from a ReadableStream.
 * Handles chunked transfer encoding where events may span multiple chunks.
 *
 * SSE format:
 *   event: <type>\n
 *   data: <payload>\n
 *   \n
 *
 * Events are delimited by double newlines (\n\n).
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newline (event delimiter)
      const parts = buffer.split("\n\n");
      // Last part may be incomplete — keep it in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        let event: string | undefined;
        let data = "";

        for (const line of part.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data = line.slice(5).trim();
          }
          // Ignore other fields (id:, retry:, comments starting with :)
        }

        if (data) {
          yield { event, data };
        }
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      let event: string | undefined;
      let data = "";

      for (const line of buffer.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data = line.slice(5).trim();
        }
      }

      if (data) {
        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

---

## Gap 4: Singleton Implementation Details

No reference code exists for this. Here's the complete implementation:

**`src/singleton.ts`:**
```typescript
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const LOCK_DIR = path.join(os.homedir(), ".proxy-claude");
const LOCK_FILE = path.join(LOCK_DIR, "server.lock");

export interface LockInfo {
  pid: number;
  port: number;
  nonce: string;
  timestamp: number;
}

/**
 * Check if another proxyClaude instance is already running.
 * Two-phase check: lock file + HTTP health probe.
 */
export async function checkExistingInstance(port: number): Promise<LockInfo | null> {
  // Phase 1: Read lock file
  let lockInfo: LockInfo;
  try {
    const content = await fs.readFile(LOCK_FILE, "utf8");
    lockInfo = JSON.parse(content) as LockInfo;
  } catch {
    return null; // No lock file or invalid JSON
  }

  // Phase 2: Check if PID is alive
  try {
    process.kill(lockInfo.pid, 0); // Signal 0 = existence check, doesn't kill
  } catch {
    // PID is dead — stale lock
    await removeLockFile();
    return null;
  }

  // Phase 3: HTTP health probe
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${lockInfo.port}/`,
        { timeout: 2000 },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              resolve(parsed.status === "ok");
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });

    if (ok) return lockInfo;
  } catch {
    // Server not responding — stale lock
  }

  await removeLockFile();
  return null;
}

export async function writeLockFile(info: LockInfo): Promise<void> {
  await fs.mkdir(LOCK_DIR, { recursive: true });
  await fs.writeFile(LOCK_FILE, JSON.stringify(info, null, 2));
}

export async function removeLockFile(): Promise<void> {
  try {
    await fs.unlink(LOCK_FILE);
  } catch {
    // Ignore — file may not exist
  }
}
```

---

## Gap 5: Config / Settings / Model Picker Implementation

No reference code for the interactive model picker using Node.js readline.

**Key function for `src/config.ts`:**
```typescript
import readline from "node:readline";

/**
 * Prompt user to select from a numbered list.
 * All output goes to stderr so it doesn't interfere with claude's stdio.
 */
export async function pickModel(
  models: Array<{ id: string; name: string }>,
  prompt: string,
  defaultIndex: number = 0,
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  // Display numbered list
  console.error("");
  console.error(`  ${prompt}`);
  console.error("");
  models.forEach((m, i) => {
    console.error(`    ${i + 1}. ${m.id}`);
  });
  console.error("");

  return new Promise((resolve) => {
    rl.question(`  Choice [${defaultIndex + 1}]: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(models[defaultIndex].id);
        return;
      }
      const index = parseInt(trimmed, 10) - 1;
      if (index >= 0 && index < models.length) {
        resolve(models[index].id);
      } else {
        resolve(models[defaultIndex].id);
      }
    });
  });
}
```

**Settings merge logic:**
```typescript
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");

export async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(SETTINGS_FILE, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await fs.mkdir(CLAUDE_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

export async function hasProxySettings(): Promise<boolean> {
  const settings = await readSettings();
  const env = settings.env as Record<string, string> | undefined;
  return env?.ANTHROPIC_BASE_URL?.startsWith("http://127.0.0.1:") ?? false;
}

export async function updateNonce(nonce: string): Promise<void> {
  const settings = await readSettings();
  const env = (settings.env ?? {}) as Record<string, string>;
  env.ANTHROPIC_AUTH_TOKEN = nonce;
  settings.env = env;
  await writeSettings(settings);
}
```

---

## Gap 6: ensureClaudeCode Implementation

**For `src/config.ts`:**
```typescript
import { execSync } from "node:child_process";
import { accessSync } from "node:fs";

function getClaudeFallbackPath(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".local", "bin", "claude.exe");
  }
  return path.join(os.homedir(), ".local", "bin", "claude");
}

function isClaudeInPath(): boolean {
  const checkCmd = process.platform === "win32" ? "where claude" : "which claude";
  try {
    execSync(checkCmd, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isClaudeAtFallbackPath(): boolean {
  try {
    accessSync(getClaudeFallbackPath());
    return true;
  } catch {
    return false;
  }
}

function getInstallCommand(): string {
  if (process.platform === "win32") {
    return 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"';
  }
  return "curl -fsSL https://claude.ai/install.sh | bash";
}

function getManualInstallInstructions(): string {
  if (process.platform === "win32") {
    return [
      "  To install manually, run one of:",
      "    PowerShell:  irm https://claude.ai/install.ps1 | iex",
      '    CMD:         curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
    ].join("\n");
  }
  return [
    "  To install manually, run:",
    "    curl -fsSL https://claude.ai/install.sh | bash",
  ].join("\n");
}

export async function ensureClaudeCode(): Promise<void> {
  // Step 1: Check if claude is in PATH
  if (isClaudeInPath()) return;

  // Step 2: Check fallback path (~/.local/bin/claude)
  if (isClaudeAtFallbackPath()) {
    console.error(
      `[proxyClaude] Found 'claude' at ${getClaudeFallbackPath()} but it's not in your PATH.`,
    );
    console.error("  Add ~/.local/bin to your PATH to avoid this warning.");
    return;
  }

  // Step 3: Not found anywhere
  const installCmd = getInstallCommand();
  console.error("[proxyClaude] 'claude' command not found.");
  console.error("");
  console.error("  Claude Code is required but not installed.");
  console.error(`  Install command: ${installCmd}`);
  console.error("");

  const answer = await askYesNo("  Install now? [Y/n]: ");

  if (!answer) {
    console.error("");
    console.error(getManualInstallInstructions());
    console.error("");
    process.exit(1);
  }

  // Step 4: Run platform-specific installer
  console.error("[proxyClaude] Installing Claude Code...");
  try {
    execSync(installCmd, { stdio: "inherit" });
  } catch {
    console.error("[proxyClaude] Installation failed.");
    console.error(getManualInstallInstructions());
    process.exit(1);
  }

  // Step 5: Re-check — first try PATH, then fallback
  if (isClaudeInPath()) {
    console.error("[proxyClaude] Claude Code installed successfully.");
    return;
  }

  if (isClaudeAtFallbackPath()) {
    console.error("[proxyClaude] Claude Code installed successfully.");
    console.error(
      "  Note: 'claude' was installed to ~/.local/bin but is not in your PATH.",
    );
    console.error("  Add ~/.local/bin to your PATH, or restart your terminal.");
    return;
  }

  // Step 6: Still not found
  console.error(
    "[proxyClaude] Installation completed but 'claude' command not found.",
  );
  console.error(
    "  You may need to add ~/.local/bin to your PATH or restart your terminal.",
  );
  process.exit(1);
}

function askYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
    });
  });
}
```

---

## Gap 7: Windows-Specific Considerations

### Token file permissions
`fs.chmod(path, 0o600)` is a no-op on Windows. This is acceptable — Windows user home
directories have appropriate ACLs by default. The code should still call chmod but not
fail if it's a no-op:
```typescript
try {
  await fs.chmod(tokenFile, 0o600);
} catch {
  // Ignore on Windows where chmod is not meaningful
}
```

### Lock file path
`~/.proxy-claude/` on Windows = `C:\Users\<username>\.proxy-claude\`
`os.homedir()` handles this correctly on all platforms.

### Claude command resolution
On Windows, `claude` may be installed as `claude.cmd` or `claude.ps1`.
Using `spawn('claude', [], { shell: true })` handles this — `shell: true` causes
Node to use `cmd /c claude` which resolves `.cmd`/`.bat`/`.exe` extensions.

### SIGINT handling
`process.on('SIGINT', ...)` works in Node.js on Windows terminal.
The child process with `stdio: 'inherit'` shares the console, so Ctrl+C is
delivered to both parent and child via the console control handler.

### Lock file cleanup on crash
If the process crashes without cleanup, the lock file becomes stale.
The `checkExistingInstance` function handles this via the PID alive check +
HTTP probe. Stale locks are automatically cleaned up on next run.

---

## Gap 8: Server Request Body Reading

The reference code uses Hono's `c.req.json()`. With raw Node.js http, we need:

```typescript
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
```

This is the same pattern used in GHCP's `ClaudeLanguageModelServer` (line 144-153).

---

## Gap 9: Error Response Format

When the server returns errors, they should be in Anthropic error format:

```typescript
function sendError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  const body = JSON.stringify({
    type: "error",
    error: { type, message },
  });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// Usage:
// sendError(res, 401, "authentication_error", "Invalid authentication");
// sendError(res, 404, "not_found_error", "Not found");
// sendError(res, 500, "api_error", "Internal server error");
```

This matches GHCP's `sendErrorResponse` method (claudeLanguageModelServer.ts lines 283-295).

---

## Gap 10: Copilot API Error Forwarding

When the Copilot API returns an error, we should forward it with appropriate status:

```typescript
// In server.ts, when createChatCompletions response is not ok:
if (!response.ok) {
  const errorBody = await response.text();
  res.writeHead(response.status, { "Content-Type": "application/json" });
  res.end(errorBody);
  return;
}
```
