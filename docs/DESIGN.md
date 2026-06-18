# proxyClaude — Design Document

## What We're Building

A standalone CLI tool (`proxyClaude`) for Microsoft employees that, in a single command:
1. Checks for Claude Code CLI (offers to install if missing)
2. Authenticates with GitHub Copilot (device code flow, persists token)
3. Starts a singleton local proxy (Anthropic Messages API -> Copilot OpenAI API)
4. On first run, interactively picks models and saves to `~/.claude/settings.json`
5. Spawns `claude` as a child process with inherited stdio
6. Cleans up on exit

**Separate project** — lives in its own repo, will be hosted on Azure DevOps.
**Zero runtime deps** — uses only Node.js 18+ built-ins. Bun for dev, bundles to single JS file via tsdown.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Developer's Machine                       │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            proxyClaude (single command)                │   │
│  │                                                        │   │
│  │  0. Check Claude Code CLI (offer install if missing)   │   │
│  │  1. Auth (device code flow → persist token)            │   │
│  │  2. Start proxy server (singleton)                     │   │
│  │  3. First-run: pick models → save settings.json        │   │
│  │  4. Spawn `claude` with inherited stdio                │   │
│  └──────────┬───────────────────────────────┘            │   │
│             │                                              │   │
│  ┌──────────▼──────────┐    ┌───────────────────────┐     │   │
│  │   Claude Code CLI    │───▶│  Local Proxy :4141     │     │   │
│  │   (child process)    │    │  127.0.0.1 only        │     │   │
│  │                      │    │                         │     │   │
│  │  ANTHROPIC_BASE_URL= │    │  Accept: Anthropic      │     │   │
│  │  http://127.0.0.1:   │    │  Messages API           │     │   │
│  │  4141                │    │        │                 │     │   │
│  │                      │    │  Translate → OpenAI      │     │   │
│  │  ANTHROPIC_AUTH_TOKEN=│◀───│  Chat Completions       │     │   │
│  │  <nonce>             │SSE │        │                 │     │   │
│  │                      │    │  Forward to Copilot →    │     │   │
│  │  stdio: inherit      │    │        │                 │     │   │
│  └──────────────────────┘    │  Translate ← back        │     │   │
│                              │  Stream response          │     │   │
│                              └───────────┬──────────────┘     │   │
│                                          │                     │   │
└──────────────────────────────────────────┼─────────────────────┘
                                           │ HTTPS
                                           ▼
                               ┌──────────────────────┐
                               │  GitHub Copilot API   │
                               │  api.business.        │
                               │  githubcopilot.com    │
                               │                       │
                               │  /chat/completions    │
                               │  (OpenAI format)      │
                               │                       │
                               │  Models: claude-      │
                               │  sonnet-4, gpt-4.1    │
                               └──────────────────────┘
```

---

## User Experience Flow

### First-time user (Claude Code not installed)
```
$ proxyClaude

[proxyClaude] Checking for Claude Code CLI...
[proxyClaude] 'claude' command not found.

  Claude Code is required but not installed.
  Install command: curl -fsSL https://claude.ai/install.sh | bash

  Install now? [Y/n]: Y

[proxyClaude] Installing Claude Code...
  curl -fsSL https://claude.ai/install.sh | bash
  ...
  Claude Code installed successfully

[proxyClaude] Claude Code installed successfully.

[proxyClaude] Authenticating with GitHub...
[proxyClaude] No saved token found. Starting GitHub login...

  ┌─────────────────────────────────────────────────┐
  │                                                   │
  │   Please enter the code  AB12-CD34  at:           │
  │   https://github.com/login/device                 │
  │                                                   │
  └─────────────────────────────────────────────────┘

  Waiting for authorization...
  Waiting for authorization...

[proxyClaude] Logged in as octocat
[proxyClaude] Token saved to ~/.proxy-claude/github_token

[proxyClaude] Exchanging for Copilot token... OK
[proxyClaude] Starting proxy server...
[proxyClaude] Proxy running on http://127.0.0.1:4141

[proxyClaude] Fetching available models...

  First-time setup — select your models:

  Available models:
    1. claude-sonnet-4
    2. claude-opus-4
    3. gpt-4.1
    4. gpt-4.1-mini
    5. o4-mini

  Primary model (ANTHROPIC_MODEL) [1]: 1
  Small/fast model (ANTHROPIC_SMALL_FAST_MODEL) [4]: 4

[proxyClaude] Settings saved to ~/.claude/settings.json
[proxyClaude] Launching Claude Code...

╭────────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code!                          │
╰────────────────────────────────────────────────────╯

>
```

### Returning user (everything cached)
```
$ proxyClaude

[proxyClaude] Authenticated as octocat

[proxyClaude] Starting proxy server...
[proxyClaude] Proxy running on http://127.0.0.1:4141

[proxyClaude] First-time setup — select your models:

Available models:
  1. claude-sonnet-4
  2. claude-opus-4
  3. gpt-4.1
  4. gpt-4.1-mini
  ...

Primary model (ANTHROPIC_MODEL) [1]: 1
Small/fast model (ANTHROPIC_SMALL_FAST_MODEL) [4]: 4

[proxyClaude] Settings saved to ~/.claude/settings.json
[proxyClaude] Launching Claude Code...

╭─────────────────────────────────────╮
│  Claude Code (powered by Copilot)   │
│  ...                                │
╰─────────────────────────────────────╯
```

On subsequent runs:
```
$ proxyClaude

[proxyClaude] Authenticated as octocat
[proxyClaude] Proxy running on http://127.0.0.1:4141
[proxyClaude] Launching Claude Code...

╭─────────────────────────────────────╮
│  Claude Code (powered by Copilot)   │
╰─────────────────────────────────────╯
```

Second terminal (parallel instance):
```
$ proxyClaude

[proxyClaude] Proxy already running (pid 12345, port 4141)
[proxyClaude] Launching Claude Code...

╭─────────────────────────────────────╮
│  Claude Code (powered by Copilot)   │
╰─────────────────────────────────────╯
```

---

## Project Structure

```
proxy-claude/
├── src/
│   ├── main.ts              # Entry point, orchestrates full flow
│   ├── auth.ts              # GitHub OAuth device code + Copilot token exchange/refresh
│   ├── server.ts            # Node.js http server (Anthropic Messages API endpoint)
│   ├── translate.ts         # Anthropic → OpenAI request + OpenAI → Anthropic response
│   ├── translate-stream.ts  # OpenAI SSE → Anthropic SSE streaming translation
│   ├── copilot.ts           # Copilot API client (chat completions, models, SSE parser)
│   ├── singleton.ts         # Lock file + port probe for singleton behavior
│   ├── config.ts            # ~/.claude/settings.json management + model picker
│   ├── constants.ts         # URLs, client ID, headers, version strings
│   └── types.ts             # All TypeScript interfaces
├── docs/
│   ├── DESIGN.md            # This file
│   ├── GHCP-COMPARISON.md   # Compliance comparison with official GHCP extension
│   └── IMPLEMENTATION.md    # Step-by-step implementation plan
├── package.json
├── tsconfig.json
└── tsdown.config.ts
```

---

## Key Design Decisions

### 1. Zero Runtime Dependencies
Everything uses Node.js 18+ built-in modules:
- `http` — proxy server
- `fs/promises` — file I/O (token persistence, settings)
- `path`, `os` — cross-platform paths
- `readline` — interactive prompts (model picker)
- `child_process` — spawning claude
- `crypto` — nonce generation (`randomUUID()`)
- `net` — port probing (singleton check)
- Global `fetch` — HTTP requests (Node 18+)

### 2. Hardcoded to Business Account
No account type selection. MS employees use Copilot Business:
- Endpoint: `https://api.business.githubcopilot.com`
- No prompt, no flag, no config

### 3. Nonce-Based Auth (Same as GHCP)
- Server generates a random nonce on startup: `crypto.randomUUID()`
- Passed to claude via `ANTHROPIC_AUTH_TOKEN` env var (CLI mode, sends `Authorization: Bearer` header)
- Validated on every request via `x-api-key` or `Authorization: Bearer` header
- Never logged, persisted only in lock file for session management

### 4. Singleton Server via Lock File
- Lock file at `~/.proxy-claude/server.lock` with `{pid, port, nonce, timestamp}`
- On startup: check lock file → check PID alive → probe port → reuse or start fresh
- Stale locks (dead PID or unresponsive port) are automatically cleaned up

### 5. Spawn claude with stdio: "inherit"
- Claude Code takes over the terminal completely
- All proxyClaude output goes to stderr (doesn't interfere)
- Ctrl+C propagates naturally through process group
- On claude exit: cleanup proxy, clear token refresh, remove lock file

### 6. Settings Written to ~/.claude/settings.json
- Read-modify-write (preserves existing user settings)
- Contains env vars Claude Code needs:
  ```json
  {
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141",
      "ANTHROPIC_AUTH_TOKEN": "<nonce>",
      "ANTHROPIC_MODEL": "claude-sonnet-4",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4",
      "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1-mini",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1-mini",
      "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    }
  }
  ```

---

## Security Model

| Concern | Mitigation |
|---------|-----------|
| Network exposure | Server binds `127.0.0.1` only — no network access |
| Request authentication | Nonce-based auth on every request (same as GHCP) |
| Token storage | GitHub token at `~/.proxy-claude/github_token` with `0o600` |
| Token logging | Never logged to console |
| Copilot token | In-memory only, never persisted, auto-refreshed |
| Nonce lifecycle | Generated per server instance, shared via lock file + env var |
| Data collection | None — no telemetry, no analytics |

---

## Translation Layer

The only non-trivial code — translates between Anthropic Messages API (what Claude Code speaks) and OpenAI Chat Completions API (what Copilot's public endpoint speaks).

### Why Translation is Needed
- GHCP accesses CAPI's native Messages API endpoint via the internal `@vscode/copilot-api` SDK
- We can't use that SDK — it's internal to VS Code extensions
- The public Copilot API at `api.business.githubcopilot.com` speaks OpenAI Chat Completions format
- So we must translate: Anthropic → OpenAI (request) and OpenAI → Anthropic (response)

### What Gets Translated

**Request (Anthropic → OpenAI):**
| Anthropic | OpenAI |
|-----------|--------|
| `system` (top-level) | `messages[0].role = "system"` |
| `content: [{type: "text", text}]` | `content: "text"` (flatten single) |
| `content: [{type: "tool_use"}]` | `tool_calls: [...]` |
| `content: [{type: "tool_result"}]` | `role: "tool"` messages |
| `tools: [{input_schema}]` | `tools: [{function: {parameters}}]` |
| `tool_choice: {type: "any"}` | `tool_choice: "required"` |

**Response (OpenAI → Anthropic):**
| OpenAI | Anthropic |
|--------|-----------|
| `finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `choices[0].message.content` | `content: [{type: "text", text}]` |
| `choices[0].message.tool_calls` | `content: [{type: "tool_use"}]` |

**Streaming (OpenAI SSE → Anthropic SSE):**
```
OpenAI: data: {"choices":[{"delta":{"content":"..."}}]}
  ↓
Anthropic: event: content_block_delta
           data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
```

The translation logic is ported from `copilot-api`, which has been tested and is in production use.

### Model id aliasing

GHCP uses non-standard dot-versioned Claude ids (`claude-opus-4.7-1m-internal`) that break Claude Code's dash-substring matchers (effort, display name, adaptive thinking). The proxy rewrites the id to the dash-canonical form (`claude-opus-4-7`) before Claude Code sees it, and resolves it back to the real GHCP id before forwarding upstream.

See **[docs/MODEL-ALIASING.md](./MODEL-ALIASING.md)** for the full rationale, alias rule, collision policy, and end-to-end flow.

---

## Reference Implementation

This project adapts code from two sources:

1. **copilot-api** (https://github.com/nicepkg/copilot-api) — The translation layer, auth flow, and API client code. Open source, MIT licensed.

2. **vscode-copilot-chat** (internal MS repo) — The `ClaudeLanguageModelServer` architecture pattern: local HTTP proxy, nonce auth, env var passing, child process spawning. We follow the same security patterns.
