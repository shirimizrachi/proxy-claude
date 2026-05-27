# proxyClaude — Implementation Plan

## Overview

This document provides the step-by-step implementation plan for proxyClaude.
Each step lists the file to create, its responsibilities, key functions, and reference
source files from `copilot-api` that the implementation adapts from.

---

## Step 1: Project Scaffold

Create `proxy-claude/` with build configuration files.

### `package.json`
```json
{
  "name": "proxy-claude",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "proxyClaude": "./dist/main.js"
  },
  "scripts": {
    "build": "tsdown",
    "dev": "node --watch --experimental-strip-types ./src/main.ts"
  },
  "devDependencies": {
    "tsdown": "^0.15.6",
    "typescript": "^5.9.3"
  }
}
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

### `tsdown.config.ts`
```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  sourcemap: false,
  clean: true,
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node" },
});
```

---

## Step 2: `src/types.ts` — Type Definitions

**Port from:**
- `copilot-api/src/routes/messages/anthropic-types.ts` (207 lines) — all Anthropic types
- `copilot-api/src/services/copilot/create-chat-completions.ts` — OpenAI types
- `copilot-api/src/services/copilot/get-models.ts` — model types

**Types to include:**

### Anthropic Types (from anthropic-types.ts)
- `AnthropicMessagesPayload` — full request body
- `AnthropicMessage`, `AnthropicUserMessage`, `AnthropicAssistantMessage`
- Content blocks: `AnthropicTextBlock`, `AnthropicImageBlock`, `AnthropicToolUseBlock`, `AnthropicToolResultBlock`, `AnthropicThinkingBlock`
- `AnthropicTool` — tool definition with `input_schema`
- `AnthropicResponse` — full response body
- Stream events: `AnthropicStreamEventData`, `AnthropicStreamState`
- All event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `error`

### OpenAI Types (from create-chat-completions.ts)
- `ChatCompletionsPayload` — request body
- `Message`, `ContentPart`, `TextPart`, `ImagePart`
- `Tool`, `ToolCall`
- `ChatCompletionResponse`, `ChatCompletionChunk`
- `Choice`, `ChoiceNonStreaming`, `Delta`, `ResponseMessage`
- Usage types including `prompt_tokens_details`

### Model Types (from get-models.ts)
- `ModelsResponse`, `Model`, `ModelCapabilities`, `ModelLimits`, `ModelSupports`

### New Types
- `ProxyClaudeState` — runtime state (tokens, models, refresh timer)
- `LockFileContent` — singleton lock file schema
- `DeviceCodeResponse` — GitHub device code flow response
- `CopilotTokenResponse` — Copilot token exchange response

---

## Step 3: `src/constants.ts` — Configuration

**Port from:** `copilot-api/src/lib/api-config.ts` (53 lines)

### Constants
```
GITHUB_BASE_URL      = "https://github.com"
GITHUB_API_BASE_URL  = "https://api.github.com"
GITHUB_CLIENT_ID     = "Iv1.b507a08c87ecfe98"
GITHUB_APP_SCOPES    = "read:user"
COPILOT_BASE_URL     = "https://api.business.githubcopilot.com"  (hardcoded business)
COPILOT_VERSION      = "0.26.7"
VSCODE_VERSION       = "1.104.3"  (hardcoded, no dynamic fetch)
DEFAULT_PORT         = 4141
```

### Functions
- `standardHeaders()` → `{ "Accept": "application/json", "Content-Type": "application/json" }`
- `githubHeaders(githubToken)` → standard + `Authorization: token ${githubToken}` + editor version headers
- `copilotHeaders(copilotToken)` → Bearer auth + editor spoofing + request ID + copilot-specific headers

---

## Step 4: `src/auth.ts` — Authentication

**Port from:**
- `copilot-api/src/lib/token.ts` (96 lines)
- `copilot-api/src/services/github/get-device-code.ts` (31 lines)
- `copilot-api/src/services/github/poll-access-token.ts` (59 lines)
- `copilot-api/src/services/github/get-copilot-token.ts` (24 lines)

### Token Storage
- Directory: `~/.proxy-claude/`
- File: `~/.proxy-claude/github_token` (plaintext, `0o600`)

### Functions
- `authenticate(): Promise<string>` — main entry: read token from disk or run device code flow
- `requestDeviceCode(): Promise<DeviceCodeResponse>` — `POST https://github.com/login/device/code`
- `pollAccessToken(deviceCode): Promise<string>` — poll `POST https://github.com/login/oauth/access_token` with `(interval + 1) * 1000` ms delay
- `getCopilotToken(githubToken): Promise<CopilotTokenResponse>` — `GET https://api.github.com/copilot_internal/v2/token`
- `setupCopilotToken(githubToken, onToken): Promise<{token, refreshTimer}>` — exchange + `setInterval` at `(refresh_in - 60) * 1000` ms

### Notes
- All interactive output to stderr (`console.error()`)
- Token validation: try reading persisted token, verify with `getCopilotToken()`, re-auth if invalid
- Polling: honor `expires_in`, fail if exceeded

---

## Step 5: `src/copilot.ts` — Copilot API Client

**Port from:**
- `copilot-api/src/services/copilot/create-chat-completions.ts` (194 lines)
- `copilot-api/src/services/copilot/get-models.ts` (56 lines)

### Functions
- `getModels(copilotToken): Promise<ModelsResponse>` — `GET ${COPILOT_BASE_URL}/models`
- `createChatCompletions(payload, copilotToken): Promise<Response>` — `POST ${COPILOT_BASE_URL}/chat/completions`
  - Always returns raw `Response` (caller handles streaming vs non-streaming)
  - Sets `X-Initiator: "agent"` if messages contain assistant/tool roles, else `"user"`
  - Sets `copilot-vision-request: "true"` if payload contains image content
- `parseSSE(body: ReadableStream): AsyncGenerator<{event?, data}>` — SSE parser
  - Reads body as text chunks, buffers across chunk boundaries
  - Splits on `\n\n` delimiter
  - Yields `{event, data}` for each SSE frame
  - Replaces `fetch-event-stream` dependency with ~35 lines of code

---

## Step 6: `src/translate.ts` — Non-Streaming Translation

**Port from:**
- `copilot-api/src/routes/messages/non-stream-translation.ts` (358 lines)
- `copilot-api/src/routes/messages/utils.ts` (17 lines)

### Request Translation (Anthropic → OpenAI)
- `translateToOpenAI(payload: AnthropicMessagesPayload): ChatCompletionsPayload`
  - `translateModelName(model)` — normalize `claude-sonnet-4-*` → `claude-sonnet-4`
  - `translateAnthropicMessagesToOpenAI(messages, system)` — full message array conversion
  - `handleSystemPrompt(system)` — string or array of text blocks → system message
  - `handleUserMessage(msg)` — text/image/tool_result blocks → OpenAI messages (tool_results become separate `role: "tool"` messages)
  - `handleAssistantMessage(msg)` — text/tool_use blocks → assistant message with `tool_calls`
  - `mapContent(content)` — flatten single text blocks, handle thinking blocks, images
  - `translateAnthropicToolsToOpenAI(tools)` — `{name, input_schema}` → `{type: "function", function: {name, parameters}}`
  - `translateAnthropicToolChoiceToOpenAI(choice)` — `auto`→`"auto"`, `any`→`"required"`, `tool`→`{type:"function",...}`, `none`→`"none"`

### Response Translation (OpenAI → Anthropic)
- `translateToAnthropic(response: ChatCompletionResponse): AnthropicResponse`
  - Merge all choices into single content array
  - `getAnthropicTextBlocks(content)` — extract text blocks
  - `getAnthropicToolUseBlocks(toolCalls)` — `JSON.parse(arguments)` for each tool call
  - Map `finish_reason` → `stop_reason` via `mapOpenAIStopReasonToAnthropic()`
  - Handle token usage including `cache_read_input_tokens` from `cached_tokens`

### Stop Reason Mapping
```
stop         → end_turn
length       → max_tokens
tool_calls   → tool_use
content_filter → end_turn
```

---

## Step 7: `src/translate-stream.ts` — Streaming Translation

**Port from:** `copilot-api/src/routes/messages/stream-translation.ts` (191 lines)

### Functions
- `translateChunkToAnthropicEvents(chunk, state): AnthropicStreamEventData[]`
- `translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData`

### State Machine (`AnthropicStreamState`)
```typescript
{
  messageStartSent: boolean       // Has message_start been emitted?
  contentBlockIndex: number       // Current content block index
  contentBlockOpen: boolean       // Is a content block currently open?
  toolCalls: {                    // Map OpenAI tool index → Anthropic block info
    [index: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
}
```

### Event Sequence Produced
```
message_start           (once, on first chunk)
content_block_start     (on new text or tool block)
content_block_delta     (repeated, text_delta or input_json_delta)
content_block_stop      (on block end or transition)
message_delta           (on finish_reason, includes final usage)
message_stop            (final event)
```

### Key Logic
- Text content closes any open tool block before starting text block
- Tool calls close any open text block before starting tool block
- Tool call `id` + `name` → `content_block_start` with `type: "tool_use"`
- Tool call `arguments` → `content_block_delta` with `type: "input_json_delta"`
- `finish_reason` → close any open block, emit `message_delta` + `message_stop`

---

## Step 8: `src/singleton.ts` — Singleton Behavior

**New code** (no direct copilot-api equivalent).

### Files
- Lock file: `~/.proxy-claude/server.lock`
- Format: `{ pid: number, port: number, nonce: string, timestamp: number }`

### Functions
- `checkExistingInstance(port): Promise<LockFileContent | null>`
  1. Read lock file → parse JSON
  2. Check PID alive: `process.kill(pid, 0)` (signal 0 = existence check)
  3. HTTP GET `http://127.0.0.1:{port}/` → verify response
  4. If both pass: return lock info. Otherwise: delete stale lock, return null
- `writeLockFile(info): Promise<void>` — write JSON with pid, port, nonce, timestamp
- `removeLockFile(): Promise<void>` — delete lock file (ignore if missing)

---

## Step 9: `src/config.ts` — Settings Management

**Partially adapted from:** `copilot-api/src/start.ts` (lines 69-111)

### Files
- Settings: `~/.claude/settings.json`

### Functions
- `hasProxySettings(): Promise<boolean>` — check if `env.ANTHROPIC_BASE_URL` points to `http://127.0.0.1:4141`
- `readSettings(): Promise<Record<string, unknown>>` — read and parse (or empty object)
- `writeSettings(settings): Promise<void>` — write back (pretty-printed JSON)
- `updateNonce(nonce): Promise<void>` — update just the `ANTHROPIC_AUTH_TOKEN` in existing settings
- `pickModel(models, prompt): Promise<string>` — numbered list, readline prompt on stderr
- `configureFirstRun(models, serverUrl, nonce): Promise<void>` — full first-run flow:
  1. Display model list
  2. Prompt for primary model
  3. Prompt for small/fast model
  4. Merge env vars into settings.json
- `ensureClaudeCode(): Promise<void>` — check if `claude` CLI is available:
  1. Try `which claude` (Unix) or `where claude` (Windows) via `child_process.execSync`
  2. If found → return
  3. Check fallback path `~/.local/bin/claude` (Unix) or `%USERPROFILE%\.local\bin\claude.exe` (Windows)
  4. If fallback exists → warn about PATH, return
  5. If not found → prompt user: "Claude Code is required but not installed. Install now? [Y/n]"
  6. If Y → run native installer: `curl -fsSL https://claude.ai/install.sh | bash` (Unix) or `irm https://claude.ai/install.ps1 | iex` (Windows)
  7. Re-check: try which/where again, then fallback path
  8. If n or install failed → print manual install instructions (platform-specific) and `process.exit(1)`

### Settings Merge Strategy
- Read existing `~/.claude/settings.json`
- Deep merge: only update `env` keys we control, preserve everything else
- Write back with `JSON.stringify(settings, null, 2)`

---

## Step 10: `src/server.ts` — HTTP Proxy Server

**Adapted from:** `copilot-api/src/routes/messages/handler.ts` (92 lines) + GHCP's `ClaudeLanguageModelServer`

### Server Setup
- `http.createServer()`, bind `127.0.0.1:4141`
- Routes:
  - `GET /` → `{"status":"ok"}`
  - `POST /v1/messages` → main handler
  - `POST /v1/messages/count_tokens` → `{"input_tokens": 1}`

### Auth Middleware
Check every request for nonce in `x-api-key` or `Authorization: Bearer` header.
Return 401 if invalid (same pattern as GHCP lines 126-141).

### Messages Handler Flow

**Non-streaming:**
1. Parse body as `AnthropicMessagesPayload`
2. `translateToOpenAI(payload)` → OpenAI format
3. `createChatCompletions(openAIPayload, copilotToken)` → fetch response
4. Parse response JSON as `ChatCompletionResponse`
5. `translateToAnthropic(response)` → Anthropic format
6. Write JSON response with `Content-Type: application/json`

**Streaming:**
1. Parse body as `AnthropicMessagesPayload` (with `stream: true`)
2. `translateToOpenAI(payload)` → OpenAI format (with `stream: true`)
3. `createChatCompletions(openAIPayload, copilotToken)` → fetch response (streaming)
4. Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
5. Initialize `AnthropicStreamState`
6. For each SSE event from `parseSSE(response.body)`:
   a. Parse `data` as `ChatCompletionChunk`
   b. `translateChunkToAnthropicEvents(chunk, state)` → array of events
   c. For each event: `res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)`
7. `res.end()`

### Error Handling
- Copilot API errors: forward status code and error body
- Translation errors: return 500 with Anthropic error format
- Client disconnect: detect via `res.on('close')`, abort upstream request

---

## Step 11: `src/main.ts` — Entry Point

### Full Orchestration Flow
```
0. Check Claude Code CLI prerequisite
   ├── Try to resolve 'claude' command (which/where)
   ├── If found → continue
   ├── Check fallback path (~/.local/bin/claude)
   ├── If fallback exists → warn about PATH, continue
   └── If missing → prompt "Install now? [Y/n]"
       ├── Y → run native installer (curl/powershell) → continue
       └── n → print install instructions → exit

1. Check singleton (lock file + port probe)
   ├── Existing proxy found → read nonce from lock file → skip to step 7
   └── No proxy → continue

2. Authenticate with GitHub
   ├── Read persisted token from ~/.proxy-claude/github_token
   ├── If valid → use it
   └── If missing/invalid → device code flow → persist

3. Exchange for Copilot token
   └── GET /copilot_internal/v2/token → start auto-refresh interval

4. Fetch available models
   └── GET /models → cache in state

5. Start HTTP proxy server
   └── http.createServer() → listen on 127.0.0.1:4141

6. Write lock file
   └── ~/.proxy-claude/server.lock with {pid, port, nonce, timestamp}

7. Configure Claude Code (first run)
   ├── Check ~/.claude/settings.json for existing config
   ├── If missing → interactive model picker → write settings
   └── Always update ANTHROPIC_AUTH_TOKEN to current nonce

8. Spawn claude
   └── spawn('claude', [], { stdio: 'inherit', shell: true, env: {...} })

9. On claude exit
   ├── Stop server (if we started it)
   ├── Clear token refresh interval
   ├── Remove lock file (if we created it)
   └── process.exit(claude's exit code)
```

### Signal Handling
- `SIGINT` / `SIGTERM`: cleanup and exit
- Claude child process receives Ctrl+C via inherited stdio
- On Windows: `process.on('SIGINT')` works; `shell: true` handles `.cmd` resolution

---

## Implementation Order

| # | File | Depends On | Est. Lines |
|---|------|-----------|-----------|
| 1 | Project scaffold | — | ~40 |
| 2 | `src/types.ts` | — | ~200 |
| 3 | `src/constants.ts` | types | ~60 |
| 4 | `src/auth.ts` | constants | ~120 |
| 5 | `src/copilot.ts` | types, constants | ~100 |
| 6 | `src/translate.ts` | types | ~280 |
| 7 | `src/translate-stream.ts` | types | ~100 |
| 8 | `src/singleton.ts` | types | ~80 |
| 9 | `src/config.ts` | types | ~120 |
| 10 | `src/server.ts` | all above | ~200 |
| 11 | `src/main.ts` | all above | ~100 |

**Total estimated: ~1,400 lines of TypeScript**

---

## Reference Files (copilot-api)

These are the source files from `c:\repos\copilot-api` that we adapt:

| Our File | Reference Source | Lines | What We Port |
|----------|-----------------|-------|-------------|
| types.ts | `src/routes/messages/anthropic-types.ts` | 207 | All Anthropic types |
| types.ts | `src/services/copilot/create-chat-completions.ts` | 194 | OpenAI types (interfaces only) |
| types.ts | `src/services/copilot/get-models.ts` | 56 | Model types |
| constants.ts | `src/lib/api-config.ts` | 53 | URLs, headers, client ID |
| auth.ts | `src/lib/token.ts` | 96 | Auth orchestration pattern |
| auth.ts | `src/services/github/get-device-code.ts` | 31 | Device code request |
| auth.ts | `src/services/github/poll-access-token.ts` | 59 | OAuth polling |
| auth.ts | `src/services/github/get-copilot-token.ts` | 24 | Token exchange |
| copilot.ts | `src/services/copilot/create-chat-completions.ts` | 194 | API call logic |
| copilot.ts | `src/services/copilot/get-models.ts` | 56 | Model fetching |
| translate.ts | `src/routes/messages/non-stream-translation.ts` | 358 | Core translation |
| translate.ts | `src/routes/messages/utils.ts` | 17 | Stop reason mapping |
| translate-stream.ts | `src/routes/messages/stream-translation.ts` | 191 | Streaming translation |
| server.ts | `src/routes/messages/handler.ts` | 92 | Handler pattern |

---

## Verification Checklist

- [ ] `npm run build` produces `dist/main.js`
- [ ] `node dist/main.js` triggers device code flow on first run
- [ ] After auth, server starts on port 4141
- [ ] `curl http://127.0.0.1:4141/` returns `{"status":"ok"}`
- [ ] Claude Code launches and responds to prompts
- [ ] Streaming works (tool use, multi-turn conversation)
- [ ] Second instance detects existing server, skips startup
- [ ] Ctrl+C exits both claude and proxy cleanly
- [ ] `~/.claude/settings.json` is created with correct env vars
- [ ] Token refresh works for long sessions (>30 min)
