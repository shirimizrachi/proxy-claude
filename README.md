# proxy-claude

> **Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with your GitHub Copilot license — no Anthropic subscription needed.**

proxy-claude is a local proxy that connects Claude Code to the GitHub Copilot API — using **the same architectural patterns** as GitHub Copilot's official Claude Code integration in VS Code ([`ClaudeLanguageModelServer`](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/agents/claude/node/claudeLanguageModelServer.ts)):

- Local HTTP server on `127.0.0.1` accepting Anthropic Messages API requests ([same as GHCP](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/agents/claude/node/claudeLanguageModelServer.ts#L303))
- Nonce-based authentication via `x-api-key` / `Authorization: Bearer` headers ([same dual-header validation](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/agents/claude/node/claudeLanguageModelServer.ts#L126))
- `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` env vars passed to Claude Code ([same as GHCP terminal mode](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/agents/claude/vscode-node/slashCommands/terminalCommand.ts#L87))

The one difference: GHCP accesses Copilot's native Messages API via the internal `@vscode/copilot-api` SDK. Since we're standalone, we translate Anthropic ↔ OpenAI format and route through the public Copilot Chat Completions endpoint instead. The end result for Claude Code is identical.

See [`docs/GHCP-COMPARISON.md`](docs/GHCP-COMPARISON.md) for the full pattern-by-pattern compliance comparison.

---

## Prerequisites

| Requirement | How to get it |
|---|---|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **GitHub Copilot Business or Enterprise** | Via your org admin |
| **Claude Code CLI** | Auto-installed on first run, or [install manually](https://docs.anthropic.com/en/docs/claude-code/getting-started) |

---

## Quick Start

### Option 1: Run directly with npx (no clone needed)

```bash
npx proxy-claude
```

### Option 2: Run from a clone

```bash
git clone https://github.com/assafakiva_microsoft/proxy-claude.git
cd proxy-claude
npm install      # also builds automatically via the `prepare` script
npx proxy-claude
```

### Option 3: Install globally (run from anywhere)

```bash
# From inside the cloned repo:
npm install -g .

# Now available system-wide:
proxy-claude
```

On first run, proxy-claude will:

1. **Authenticate** — opens a GitHub device-code flow in your browser
2. **Fetch models** — pulls available models from the Copilot API
3. **Let you pick** — interactive prompt for your primary and small/fast models
4. **Start the proxy** — local server on a random port
5. **Launch Claude Code** — already wired up and ready to go

On subsequent runs, your GitHub token and model choices are remembered — it starts instantly.

---

## Usage

```bash
proxy-claude [--agency] [--yolo] [--reset-models] [-- <args...>]
proxy-claude update
```

| Flag / Command | Description |
|---|---|
| *(no flags)* | Start proxy and launch Claude Code |
| `update` | Check for and install the latest version (like `claude update`) |
| `--agency` | Launch via the [Agency](https://eng.ms/docs/coreai/devdiv/one-engineering-system-1es/1es-jacekcz/startrightgitops/agency/usingagency) CLI instead of `claude` directly. Extra args can be passed after `--` (e.g. `proxy-claude --agency -- --some-flag`) |
| `--yolo` | ⚠️ **DANGER** — Launch Claude Code in YOLO mode (`--dangerously-skip-permissions`) — Claude will execute tools **without asking for confirmation**. Use at your own risk! |
| `--reset-models` | Clear saved model selection and re-prompt on next run |

### Examples

```bash
# Normal launch
proxy-claude

# Update to latest version
proxy-claude update

# Launch via Agency CLI
proxy-claude --agency

# Agency with passthrough args
proxy-claude --agency -- --some-flag

# YOLO mode — no permission prompts
proxy-claude --yolo

# Re-pick models
proxy-claude --reset-models

# Combine flags
proxy-claude --reset-models --yolo

# Agency + YOLO
proxy-claude --agency --yolo
```

---

## Changing Models

To re-select models at any time:

```bash
proxy-claude --reset-models
```

Or edit `~/.claude/settings.json` directly — the relevant keys are under `env`:

```json
{
  "env": {
    "ANTHROPIC_MODEL": "claude-sonnet-4",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1-mini",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1-mini"
  }
}
```

Available model IDs depend on your Copilot license. Common ones:

| Model | Best for |
|---|---|
| `claude-sonnet-4` | Primary coding model (default) |
| `claude-opus-4` | Most capable, slower |
| `gpt-4.1` | OpenAI alternative |
| `gpt-4.1-mini` | Fast, good for small/fast slot |
| `o4-mini` | OpenAI reasoning model |

---

## How It Works

```
┌─────────────┐    Anthropic API    ┌──────────────┐   OpenAI API    ┌──────────────────┐
│  Claude Code │ ────────────────►  │ proxy-claude │ ─────────────► │ GitHub Copilot   │
│     CLI      │ ◄────────────────  │  (localhost) │ ◄───────────── │       API        │
└─────────────┘   Messages API     └──────────────┘  Chat Compls.  └──────────────────┘
```

- **Requests**: Anthropic `POST /v1/messages` → translated to OpenAI Chat Completions → Copilot API
- **Responses**: OpenAI format → translated back to Anthropic format → Claude Code
- **Streaming**: SSE chunks translated in real-time between formats

---

## Configuration

All config lives in standard locations — no dotfiles in your project:

| File | Purpose |
|---|---|
| `~/.proxy-claude/github-token` | Persisted GitHub OAuth token |
| `~/.proxy-claude/server.lock` | Lock file for singleton enforcement |
| `~/.claude/settings.json` | Claude Code settings (model, proxy URL, API key) |

### Settings stored in `~/.claude/settings.json`

| Key | Purpose |
|---|---|
| `ANTHROPIC_MODEL` | Primary model used by Claude Code |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Alias for primary model |
| `ANTHROPIC_SMALL_FAST_MODEL` | Small/fast model for lightweight tasks |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Alias for small/fast model |
| `ANTHROPIC_BASE_URL` | Proxy server URL (auto-set) |
| `ANTHROPIC_AUTH_TOKEN` | Session nonce (auto-set each run) |

### Singleton Behavior

Only one proxy runs at a time. Running `proxy-claude` again detects the existing instance and launches Claude Code against it — no port conflicts.

---

## Troubleshooting

### Reset everything

```bash
# Full reset — re-authenticate + re-select models
rm ~/.proxy-claude/github-token
rm ~/.proxy-claude/server.lock
proxy-claude
```

### Common issues

| Problem | Fix |
|---|---|
| **`sh: proxy-claude: command not found`** | Build first (`npm run build`) or install globally (`npm install -g .`) |
| **`No matching version found for @types/node`** | Run `npm install` — this is fixed in the latest version |
| **"Proxy already running"** | A previous instance is still active. If it crashed: `rm ~/.proxy-claude/server.lock` |
| **421 Misdirected Request** | Copilot API URL changed. Re-authenticate: `rm ~/.proxy-claude/github-token && proxy-claude` |
| **Claude Code not connecting** | Check proxy is running: `curl http://127.0.0.1:<port>/` should return `{"status":"ok"}` |
| **Authentication failed** | Delete token and retry: `rm ~/.proxy-claude/github-token && proxy-claude` |
| **404 "Not found" API errors** | Usually means Claude Code is hitting an unsupported endpoint — update to latest proxy-claude |

### Windows

On Windows (PowerShell), use `Remove-Item` instead of `rm`:

```powershell
# Reset auth
Remove-Item ~\.proxy-claude\github-token

# Reset lock
Remove-Item ~\.proxy-claude\server.lock
```

---

## Development

```bash
npm install          # Install dependencies (also auto-builds)
npm run dev          # Dev mode (Node 22+ with --watch)
npm run build        # Build to dist/
npm run typecheck    # Type check
npm test             # Run tests
```

### Project Structure

```
src/
├── main.ts              Entry point — orchestrates the full flow
├── auth.ts              GitHub OAuth device code + Copilot token exchange
├── server.ts            HTTP proxy (Anthropic Messages API)
├── translate.ts         Anthropic ↔ OpenAI request/response translation
├── translate-stream.ts  OpenAI SSE → Anthropic SSE streaming
├── copilot.ts           Copilot API client + SSE parser
├── singleton.ts         Lock file + port probe for singleton
├── config.ts            Settings management + model picker
├── constants.ts         URLs, client ID, headers, versions
└── types.ts             All TypeScript interfaces
```

---

## Security

- Binds to **127.0.0.1 only** — not reachable from the network
- Every request authenticated with a **random nonce** (UUID) per session
- GitHub/Copilot tokens are **never logged**
- All user-facing output goes to **stderr** (doesn't interfere with Claude Code's stdio)

---

## Acknowledgments

The translation layer, auth flow, and API client are adapted from [copilot-api](https://github.com/nicepkg/copilot-api) (MIT License) by nicepkg contributors. See `docs/REFERENCE-SOURCE.md` for the original reference code and adaptation notes.

---

## License

[MIT](LICENSE)