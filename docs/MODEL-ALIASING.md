# Model Aliasing

How proxy-claude reconciles GitHub Copilot's non-standard Claude model ids with the canonical Anthropic ids Claude Code expects.

> **TL;DR**: GHCP names Claude models with dots (`claude-opus-4.7-1m-internal`); Claude Code does substring matches on dash-separated canonical ids (`claude-opus-4-6`). The proxy rewrites the id to the dash form before Claude Code sees it, and rewrites it back to the real GHCP id before forwarding the request upstream. When several real GHCP ids would alias to the same string, the 1M-context variant wins.

## Why this exists

GHCP's `/models` endpoint exposes Claude models with **dot-separated** version numbers and internal suffixes:

```
claude-opus-4.7-1m-internal
claude-opus-4.6-1m
claude-opus-4.6
claude-opus-4.7-high
claude-opus-4.7-xhigh
claude-opus-4.7
claude-sonnet-4.6
claude-haiku-4.5
```

Real Anthropic Claude API IDs use **dash-separated** version numbers:

```
claude-opus-4-8
claude-opus-4-6
claude-sonnet-4-6
claude-haiku-4-5
```

Claude Code makes every model-capability decision via **case-insensitive substring matching** on the dash form. With a GHCP id in `~/.claude/settings.json`'s `ANTHROPIC_MODEL`, none of these matches fire:

| Claude Code check | What it expects | What GHCP gives | Result |
|---|---|---|---|
| `modelSupportsEffort` | `m.includes('opus-4-6')` | `claude-opus-4.6-1m` | false → effort never sent |
| `getPublicModelName` | `name.includes('claude-opus-4-6')` | `claude-opus-4.7-1m-internal` | falls through to "Opus 4" |
| `modelSupportsAdaptiveThinking` | similar allowlist | dot id | unsupported |

The concrete consequence: PR #21's effort passthrough is dead code on GHCP-internal models; the `/model` picker labels Opus 4.6/4.7 as plain "Opus 4". This module fixes that.

## The three strings

Three distinct strings flow through the system. **Never confuse them.**

| Concept | Example | Where it lives |
|---|---|---|
| **Real GHCP id** | `claude-opus-4.7-1m-internal` | `/models` response; upstream POST body; capability cache key |
| **Alias** | `claude-opus-4-7` | `aliasToReal` map key; matches Claude Code's substring matchers |
| **Settings id** | `claude-opus-4-7[1m]` | `~/.claude/settings.json` env vars; what Claude Code reads |

The `[1m]` suffix is Claude Code's client-side context-window hint. It's derived from the **real GHCP id's** `has1m` flag, never from the alias string (which keeps the suffix idempotent even when the alias itself contains "1m" segments).

## The alias rule

The pure function `ghcpIdToAlias(realId)` (in `src/translate.ts`) maps a real GHCP id to its alias:

```ts
// Match claude-{family}-{major}.{minor}[-{suffix}]
const m = realId.match(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)(?:-(.+))?$/i)
```

Examples:

| Real GHCP id | Alias | `has1m` |
|---|---|---|
| `claude-opus-4.7-1m-internal` | `claude-opus-4-7` | true |
| `claude-opus-4.6-1m` | `claude-opus-4-6` | true |
| `claude-opus-4.6` | `claude-opus-4-6` | false |
| `claude-sonnet-4.6` | `claude-sonnet-4-6` | false |
| `claude-haiku-4.5` | `claude-haiku-4-5` | false |
| `gpt-4.1` | _(not aliased)_ | — |
| `claude-opus-4` | _(not aliased: already canonical)_ | — |

`has1m` is determined by a separator-bounded regex (`/(^|[-_.])1m([-_.]|$)/i`) on the suffix segment — so `claude-opus-4.7-1minor` does **not** count as having 1M context.

## Collision policy: prefer 1M

Multiple real GHCP ids can produce the same alias. Real example from the GHCP catalog (June 2026):

```
claude-opus-4.7-1m-internal  → "claude-opus-4-7"
claude-opus-4.7-high         → "claude-opus-4-7"
claude-opus-4.7-xhigh        → "claude-opus-4-7"
claude-opus-4.7              → "claude-opus-4-7"
```

**Rule**: when a collision has exactly **one** `has1m=true` candidate, that 1M variant wins the alias. The losing real ids are still selectable from the picker but pass through as raw GHCP ids (no alias rewrite). When there's no unique 1M winner — zero 1M variants, or two or more — the entire collision group is dropped to avoid silently routing to the wrong model. Conservative by design.

Worked example for the catalog above: `claude-opus-4-7` aliases to `claude-opus-4.7-1m-internal`; the other three keep their raw ids.

Documented decisions:

- **"Prefer most capable" is left for later.** The current rule covers our actual catalog; a smarter heuristic (compare `max_thinking_budget`, `reasoning_effort` length, etc.) is harder to defend without real-world need.
- **Existing users on the losers are not auto-migrated.** Their `settings.json` still contains the raw id (e.g. `claude-opus-4.7-high[1m]` if they ever picked it). The proxy passes that through to GHCP unchanged. They lose the display-name benefit until `--reset-models`.

## End-to-end flow

```
                ┌────────────────────────────────────────────────────────┐
                │                  proxy-claude startup                  │
                │                                                        │
   GHCP /models │  buildAliasMaps()                                      │
   ─────────────┼─►  → aliasToReal:   "claude-opus-4-7"  → real id      │
                │   → realToAlias:   real id → "claude-opus-4-7"        │
                │   → realHas1m:     real id → true                     │
                │                                                        │
                │  saveAliasMap()  ──►  ~/.proxy-claude/model-aliases.json
                │                                                        │
                │  (first run only)                                      │
                │  configureFirstRun → realIdToSettingsId               │
                │     writes "claude-opus-4-7[1m]" to settings.json     │
                └────────────────────────┬───────────────────────────────┘
                                         │
                                         ▼
                ┌─────────────────────────────────────────┐
                │  Claude Code launches                   │
                │  ANTHROPIC_MODEL=claude-opus-4-7[1m]   │
                │  Substring matchers all work.           │
                │  Sends request with that model id.      │
                └────────────────────────┬────────────────┘
                                         │
                                         ▼
                ┌─────────────────────────────────────────────────────────┐
                │  proxy server (single mapping path)                     │
                │                                                         │
                │  mapModelToCopilot(in, modelConfig, resolveAlias)      │
                │    1. strip [1m]                                       │
                │    2. tier-name resolution (sonnet/haiku/opus)         │
                │    3. strip [1m] from tier value                       │
                │    4. resolveAlias() → real GHCP id  ◄ FINAL STEP      │
                │                                                         │
                │  Capability lookup uses the real id.                   │
                │  Outgoing payload uses the real id.                    │
                │  (No dual mapping — capability lookup and payload     │
                │   are always in sync.)                                  │
                └────────────────────────┬────────────────────────────────┘
                                         │
                                         ▼
                                   GHCP /chat/completions
                                   model: claude-opus-4.7-1m-internal
                                   reasoning_effort: xhigh
```

## Belt-and-suspenders: `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`

Even with a correct alias, Claude Code's own `modelSupportsEffort` allowlist may not yet recognize newly-shipped versions (e.g. `opus-4-7`/`opus-4-8`). The leaked Claude Code source as of early 2026 only allowlists `opus-4-6` and `sonnet-4-6`:

```ts
if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) return true
```

For our alias to actually trigger effort on `opus-4-7`, `main.ts` injects `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` into Claude Code's spawn environment **only when the primary model's GHCP capabilities expose `reasoning_effort` support**. This guarantees effort fires on capable models without risking GHCP rejection on models that don't support it.

The check happens during the owner-startup path:

```ts
const primaryRealId = aliasMaps.aliasToReal.get(stripContextHint(currentModel))
                      ?? stripContextHint(currentModel)
const primaryCaps = capabilitiesByModel.get(primaryRealId)
if (primaryCaps?.reasoning_effort?.length) {
  extraEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1"
}
```

The singleton-attach path does **not** inject the env var (the attached process doesn't have the capabilities map locally — that's owned by the running proxy). Documented limitation; an acceptable trade-off because:
- Restarts pick up the new env automatically.
- The owner process's existing sessions already have the env from launch time.

## Persistence

`~/.proxy-claude/model-aliases.json` is written every successful `/models` fetch:

```json
{
  "version": 1,
  "savedAt": 1780562843134,
  "aliases": {
    "claude-opus-4-7": "claude-opus-4.7-1m-internal",
    "claude-opus-4-6": "claude-opus-4.6-1m",
    "claude-opus-4-8": "claude-opus-4.8",
    "claude-sonnet-4-6": "claude-sonnet-4.6",
    "claude-haiku-4-5": "claude-haiku-4.5"
  }
}
```

When `/models` is unavailable (network blip, GHCP outage), the proxy loads the persisted map on startup. Without this, users with aliases in their `settings.json` would silently send the bad id to GHCP after any transient fetch failure.

## Migration

| User state | Behavior on first launch of an alias-aware proxy |
|---|---|
| **Brand new install** | First-run picker uses aliases. `settings.json` gets the dash-canonical form. |
| **Existing user, never reset** | `settings.json` still has the raw dot id. Proxy resolves it through to GHCP unchanged (no alias map hit). Effort works via the env-var fallback. Display name still wrong until `--reset-models`. |
| **`proxy-claude --reset-models`** | Clears model env vars, re-runs the picker. Now gets aliases. |
| **Existing user on a collision-loser id** (e.g. `claude-opus-4.7-high[1m]`) | Same as "never reset" — passes through, no auto-migration. |

A future PR may auto-rewrite legacy ids in `settings.json` on startup; for now the manual `--reset-models` path is the documented migration.

## Tests

The alias system is covered by:

- **`test/translate.test.ts`** — `ghcpIdToAlias` unit tests (8 cases) and `mapModelToCopilot` alias round-trip tests (8 cases).
- **`test/config.test.ts`** — `buildAliasMaps` (6 cases including all three collision scenarios) and `realIdToSettingsId` (5 cases including idempotency and non-winner pass-through).
- **`test/server.test.ts`** — e2e: alias on the wire → real id upstream (with mock GHCP), capability lookup by real id with effort clamping, unknown non-claude pass-through.

## Future improvements

1. **Smarter collision tie-breaking** when there's no unique 1M variant — e.g. prefer the entry with the longest `reasoning_effort` array, or with `adaptive_thinking: true`. Defer until a real catalog forces the issue.
2. **Auto-migration** of legacy raw ids in existing `settings.json` on startup (with a one-time backup). Avoids the `--reset-models` step.
3. **Display-name override** as a separate mechanism for the case where Claude Code's own display table doesn't yet know `opus-4-7`/`opus-4-8`. Would need a Claude Code change or a more intrusive client-side spoof.
4. **Singleton-attach env injection**: persist the "should force effort" decision in the lock file so the singleton-attach path can also inject `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` for newly-launched Claude sessions against an already-running proxy.

## Related PRs

| PR | What |
|---|---|
| [#21](https://github.com/aep-edge-microsoft/proxy-claude/pull/21) | Initial effort passthrough (`output_config.effort` → `reasoning_effort` with clamping). |
| [#22](https://github.com/aep-edge-microsoft/proxy-claude/pull/22) | Record `requestedEffort` / `sentEffort` in `usage.jsonl` so clamping is observable. |
| [#24](https://github.com/aep-edge-microsoft/proxy-claude/pull/24) | Print `proxy-claude` version at launch and in telemetry. |
| [#25](https://github.com/aep-edge-microsoft/proxy-claude/pull/25) | This PR: alias rewriting + env-var fallback + persistence + collision policy. |
