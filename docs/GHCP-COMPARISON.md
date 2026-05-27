# GHCP Compliance Comparison

## Purpose

This document compares our `proxyClaude` design against the official GitHub Copilot Chat extension's (`vscode-copilot-chat`) `ClaudeLanguageModelServer` to verify that our approach follows the same security and architectural patterns.

**Source analyzed:** `vscode-copilot-chat` extension — `src/extension/agents/claude/node/claudeLanguageModelServer.ts`

---

## Pattern-by-Pattern Comparison

### 1. Local HTTP Server

| Aspect | GHCP | proxyClaude | Verdict |
|--------|------|-------------|---------|
| Server type | `http.createServer()` (Node built-in) | `http.createServer()` (Node built-in) | **Identical** |
| Bind address | `127.0.0.1` (explicit, line 303) | `127.0.0.1` (explicit) | **Identical** |
| Port | Random (OS-assigned via port `0`) | Fixed `4141` (with singleton check) | **Different but equivalent** |
| Endpoints | `POST /v1/messages`, `GET /` | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /` | **Superset** |

### 2. Nonce-Based Authentication

| Aspect | GHCP | proxyClaude | Verdict |
|--------|------|-------------|---------|
| Nonce format | `'vscode-lm-' + generateUuid()` | `crypto.randomUUID()` | **Equivalent** |
| Nonce lifecycle | Per server instance, in-memory only | Per server instance, in lock file for singleton | **Same core pattern** |
| Header: `x-api-key` | Checked (line 130) | Checked | **Identical** |
| Header: `Authorization: Bearer` | Checked (line 134-139) | Checked | **Identical** |
| Validation | Exact string match | Exact string match | **Identical** |

GHCP code (lines 126-141):
```typescript
private async isAuthTokenValid(req: http.IncomingMessage): Promise<boolean> {
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader === this.config.nonce) return true;

    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        return token === this.config.nonce;
    }
    return false;
}
```

Our implementation replicates this exactly.

### 3. Environment Variables Passed to Claude Code

| Env Var | GHCP SDK mode | GHCP terminal mode | proxyClaude | Verdict |
|---------|---------------|-------------------|-------------|---------|
| `ANTHROPIC_BASE_URL` | `http://localhost:${port}` | `http://localhost:${port}` | `http://127.0.0.1:${port}` | **Equivalent** |
| `ANTHROPIC_API_KEY` | `nonce` | — | — | SDK only |
| `ANTHROPIC_AUTH_TOKEN` | — | `nonce` | `nonce` | **Identical** (we use CLI mode) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `'1'` | — | `'1'` | **Same** |

Note: GHCP uses `ANTHROPIC_API_KEY` in SDK agent mode and `ANTHROPIC_AUTH_TOKEN` in terminal/CLI mode.
Since proxyClaude spawns the Claude Code CLI, we use `ANTHROPIC_AUTH_TOKEN` (matching GHCP's terminal mode).

We also set additional env vars that GHCP sets via different mechanisms:
- `ANTHROPIC_MODEL` — GHCP configures this through SDK options
- `ANTHROPIC_SMALL_FAST_MODEL` — GHCP configures through SDK options
- `DISABLE_NON_ESSENTIAL_MODEL_CALLS` — Additional safety measure

### 4. Child Process Spawning

| Aspect | GHCP | proxyClaude | Verdict |
|--------|------|-------------|---------|
| Mechanism | `@anthropic-ai/claude-agent-sdk` `query()` | `child_process.spawn('claude', ...)` | **Different mechanism, same effect** |
| stdio | Managed by SDK | `stdio: 'inherit'` | **Equivalent user experience** |
| Cleanup on exit | Handled by Disposable pattern | Explicit cleanup in exit handler | **Equivalent** |

### 5. Anthropic Messages API Handling

| Aspect | GHCP | proxyClaude | Verdict |
|--------|------|-------------|---------|
| Accept format | Anthropic Messages API | Anthropic Messages API | **Identical** |
| Backend call | CAPI native Messages endpoint (via internal SDK) | Copilot public API (OpenAI format) with translation | **Different** (see note) |
| Response format | Anthropic SSE (native passthrough) | Anthropic SSE (translated from OpenAI SSE) | **Same output format** |

**Note on translation:** GHCP has access to CAPI's native `/v1/messages` endpoint via the internal `@vscode/copilot-api` SDK, so it can pass through Anthropic format directly. We cannot access this SDK, so we translate to OpenAI format for the public Copilot API and translate back. The end result (what Claude Code sees) is identical Anthropic Messages API format.

---

## What GHCP Does That We Don't (and Why)

| GHCP Feature | Our Approach | Justification |
|---|---|---|
| User-initiated message counting | Not implemented | Telemetry feature, not needed for proxy |
| Request telemetry (`X-Request-ID` tracking) | Not implemented | No telemetry by design |
| `AnthropicMessagesProcessor` for logging | Not needed | We translate, not passthrough |
| Model name mapping (`claude-sonnet-4-20250514` → `claude-sonnet-4.20250514`) | Handled in translation layer | Covered by `translateModelName()` |
| CancellationToken pattern | Client disconnect detection via `res.on('close')` | Simpler but equivalent |
| Settings source configuration | Settings in `~/.claude/settings.json` | Standard Claude Code config |
| `ClaudeSettingsChangeTracker` | Not implemented | Overkill for standalone tool |

**None of these omissions affect security or compliance.** They are VS Code extension-specific features (telemetry, Disposable pattern, settings watchers) that don't apply to a standalone CLI tool.

---

## What We Do That GHCP Doesn't (and Why)

| Our Feature | Why GHCP Doesn't Need It | Why We Need It |
|---|---|---|
| Device code OAuth flow | VS Code handles auth | We're standalone |
| Copilot token exchange + auto-refresh | VS Code extension auth context | We're standalone |
| Anthropic ↔ OpenAI translation | CAPI native Messages API via internal SDK | Can't access internal SDK |
| Singleton server (lock file) | VS Code manages lifecycle | Multiple terminal sessions |
| Interactive model picker | Extension settings UI | CLI-only interface |
| Settings.json auto-configuration | VS Code settings sync | First-run simplicity |

---

## Security Equivalence Summary

### Identical Patterns (Security-Critical)
1. **Localhost-only binding** — `127.0.0.1`, no network exposure
2. **Nonce authentication** — random UUID, dual-header validation
3. **Token isolation** — real Copilot token never exposed to Claude Code
4. **Env var passing** — nonce passed as `ANTHROPIC_AUTH_TOKEN` (CLI mode), not real credentials
5. **No token logging** — tokens never printed to console

### Our Additional Security Measures
1. **Token file permissions** — `0o600` on `~/.proxy-claude/github_token`
2. **Lock file with PID** — stale detection prevents orphaned servers
3. **No telemetry** — zero data collection
4. **Hardcoded business endpoint** — no accidental routing to wrong API

### Conclusion
**Our approach is architecturally equivalent to GHCP's `ClaudeLanguageModelServer` for all security-sensitive patterns.** The only structural difference is the translation layer (Anthropic ↔ OpenAI), which is an addition necessitated by not having access to CAPI's internal Messages API endpoint. This translation layer is ported from `copilot-api`, an established open-source project.
