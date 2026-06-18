# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

**proxyClaude** is a standalone CLI tool for Microsoft employees that lets them use Claude Code CLI powered by their GitHub Copilot Enterprise/Business license. It runs a local proxy server that translates between Anthropic Messages API (what Claude Code speaks) and OpenAI Chat Completions API (what GitHub Copilot's public API speaks).

## Architecture

**Read these docs in order before implementing:**

1. `docs/DESIGN.md` — Architecture, UX flows, design decisions, security model
2. `docs/IMPLEMENTATION.md` — Step-by-step plan with function signatures for all 10 source files
3. `docs/REFERENCE-SOURCE.md` — All source code to adapt from (copilot-api project), inlined with adaptation notes
4. `docs/GAPS.md` — **Critical implementation details** not covered in reference code (SSE parser, singleton, env vars, Windows, error handling)
5. `docs/GHCP-COMPARISON.md` — Security compliance comparison with official GitHub Copilot extension
6. `docs/MODEL-ALIASING.md` — **Read before touching any model-id handling.** Explains why proxy-claude rewrites GHCP dot-versioned ids (`claude-opus-4.7-1m-internal`) to Claude Code's dash-canonical form (`claude-opus-4-7`), the collision policy, and the `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` belt-and-suspenders.

## Key Constraints

- **Zero runtime dependencies** — only Node.js 18+ built-in modules (http, fs, path, os, readline, child_process, crypto, net, global fetch)
- **TypeScript with ESM** — `"type": "module"` in package.json
- **Builds to single file** — via tsdown, output is `dist/main.js` runnable with `node`
- **Dev dependencies only**: `tsdown`, `typescript`
- **Strict TypeScript** — `strict: true`, `noUnusedLocals`, `noUnusedParameters`
- **All interactive output to stderr** — use `console.error()` for all user-facing messages so it doesn't interfere with claude's inherited stdio
- **Security**: server binds `127.0.0.1` only, nonce-based auth on every request, tokens never logged

## File Structure

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
│   ├── config.ts            # ~/.claude/settings.json management + model picker + ensureClaudeCode
│   ├── constants.ts         # URLs, client ID, headers, version strings
│   └── types.ts             # All TypeScript interfaces
├── docs/                    # Design docs (read these first!)
├── package.json
├── tsconfig.json
└── tsdown.config.ts
```

## Implementation Order

Implement files in this exact order (dependency chain):

1. `src/types.ts` — all TypeScript interfaces
2. `src/constants.ts` — URLs, headers, config
3. `src/auth.ts` — GitHub OAuth + Copilot token
4. `src/copilot.ts` — Copilot API client + SSE parser
5. `src/translate.ts` — non-streaming Anthropic↔OpenAI translation
6. `src/translate-stream.ts` — streaming SSE translation
7. `src/singleton.ts` — lock file + port probe
8. `src/config.ts` — settings management + model picker + ensureClaudeCode
9. `src/server.ts` — HTTP proxy server
10. `src/main.ts` — entry point orchestrator

## Reference Source Code

The translation layer, auth flow, and API client are adapted from the open-source `copilot-api` project.
The full reference source code is inlined in `docs/REFERENCE-SOURCE.md` — use this as the basis for implementation.

**Do NOT copy verbatim** — adapt to remove framework dependencies (Hono, consola, etc.) and use Node.js built-ins instead.

Key adaptations needed:
- Replace `consola.info/debug/error` → `console.error()` (all output to stderr)
- Replace `~/lib/...` imports → relative `./` imports
- Replace `state.copilotToken` global → function parameter passing
- Replace Hono's `streamSSE` → raw `res.write()` for SSE
- Replace `fetch-event-stream`'s `events()` → custom async generator SSE parser
- Replace `HTTPError` class → simple error handling with status codes
- Remove rate limiting, manual approval, show-token logic

## Build & Dev Commands

```bash
# Install dev dependencies
npm install

# Development (with watch mode, requires Node 22+)
npm run dev

# Build (produces dist/main.js)
npm run build

# Run the built output
node dist/main.js
```

## Validation

After implementation is complete, verify with these steps:

### 1. Build check
```bash
npm run build
# Should produce dist/main.js with no errors
```

### 2. TypeScript check
```bash
npx tsc --noEmit
# Should have zero type errors
```

### 3. Startup check (requires GitHub account with Copilot)
```bash
node dist/main.js
# Should either:
# - Trigger device code flow (first run)
# - Start proxy and launch claude (subsequent runs)
```

### 4. Health check (while server is running)
```bash
curl http://127.0.0.1:4141/
# Should return: {"status":"ok"} when token is healthy
# Returns: {"status":"token_unhealthy"} when token is expired or refresh has been failing
```

### 5. Singleton check
```bash
# In a second terminal while first instance is running:
node dist/main.js
# Should print "Proxy already running" and launch claude without starting second server
```

### 6. Manual API test (while server is running, use nonce from lock file)
```bash
# Read nonce from lock file
cat ~/.proxy-claude/server.lock

# Test non-streaming
curl -X POST http://127.0.0.1:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <nonce-from-lock-file>" \
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Say hello"}]
  }'

# Test streaming
curl -X POST http://127.0.0.1:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <nonce-from-lock-file>" \
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 100,
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

### 7. Auth rejection test
```bash
curl -X POST http://127.0.0.1:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: wrong-nonce" \
  -d '{"model":"claude-sonnet-4","max_tokens":100,"messages":[{"role":"user","content":"test"}]}'
# Should return 401
```

### 8. Cleanup check
```bash
# Press Ctrl+C in the proxyClaude terminal
# Then verify:
cat ~/.proxy-claude/server.lock
# Should not exist (lock file cleaned up)
```

## Token Lifecycle & Resilience

The Copilot token has a limited lifetime (~30-60 min). The proxy manages this via `TokenManager` in `auth.ts`:

### Refresh mechanism
- **Scheduled refresh**: `setInterval` fires at `refresh_in - 60s` (GitHub's recommended interval minus safety buffer)
- **On-demand refresh**: Server calls `refreshNow()` when Copilot API returns 401
- **Deduplication**: `refreshInFlight` flag prevents concurrent refreshes — second caller waits for the first

### Retry with exponential backoff
- 5 attempts, delays: 3s → 6s → 12s → 24s → 48s
- Only retries transient errors: `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT`, `ENETUNREACH`, etc.
- Non-transient errors (e.g. 401 from GitHub) fail immediately

### Health tracking
- `isTokenHealthy()` returns false if: last refresh failed OR token is within 60s of expiry
- Health endpoint (`GET /`) returns `{"status":"token_unhealthy"}` when unhealthy
- Singleton check uses this to detect and kill broken proxy instances

### Common failure: DNS resolution on corporate VPN
The most common transient error is `ENOTFOUND api.github.com` during VPN reconnects, laptop sleep/wake, or Wi-Fi transitions. The retry logic handles this automatically. Node's `fetch` wraps the real error in `error.cause`, so `isTransientError()` checks both `error.message` and `error.cause.message`.

## Singleton Architecture

Only ONE proxy server runs at a time, serving all Claude Code sessions:

```
Claude A ──┐
Claude B ──┼──→ Proxy (:4141) ──→ Copilot API
Claude C ──┘         │
                     └── Token (shared, auto-refreshed)
```

- **Lock file**: `~/.proxy-claude/server.lock` contains `{pid, port, nonce, version}`
- **Owner process**: The first instance starts the server and owns its lifecycle
- **Non-owner processes**: Detect the lock file, verify health, reuse the proxy
- **SERVER_VERSION**: Bumped when server behavior changes — forces restart of old servers
- **Unhealthy detection**: New launches kill old proxies that report `token_unhealthy`
- **Unrecognized CLI flags** (e.g. `--resume`, `--continue`) are passed through to Claude Code, not rejected

## Update Check

- Runs once per 24 hours (throttled via `~/.proxy-claude/update-check.json`)
- **Repo is private/internal** — uses GitHub API with saved token from `~/.proxy-claude/github_token`
- Uses `accept: application/vnd.github.v3.raw` header to get raw file content
- URL: `https://api.github.com/repos/aep-edge-microsoft/proxy-claude/contents/package.json?ref=main`
- Compares remote `version` field against `PROXY_CLAUDE_VERSION` in `constants.ts`
- **Both `package.json` and `constants.ts` must be bumped** when releasing a new version

## Version Bumping Checklist

When releasing a new version:
1. Bump `version` in `package.json`
2. Bump `PROXY_CLAUDE_VERSION` in `src/constants.ts` (must match)
3. Bump `SERVER_VERSION` in `src/singleton.ts` if server behavior changed (forces restart of old servers)
4. Build and verify: `npx tsc --noEmit && npx tsdown`
