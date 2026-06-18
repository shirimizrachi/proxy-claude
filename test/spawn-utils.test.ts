import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { needsShellFor, quoteWindowsArg } from "../src/spawn-utils.ts"

describe("needsShellFor", () => {
  it("returns true for .cmd shims on Windows", () => {
    assert.equal(needsShellFor("C:\\npm\\claude.cmd", "win32"), true)
    assert.equal(needsShellFor("C:\\npm\\CLAUDE.CMD", "win32"), true, "case-insensitive")
  })

  it("returns true for .bat shims on Windows", () => {
    assert.equal(needsShellFor("C:\\tools\\wrapper.bat", "win32"), true)
  })

  it("returns false for .exe on Windows (native binary)", () => {
    assert.equal(needsShellFor("C:\\Program Files\\claude\\claude.exe", "win32"), false)
  })

  it("returns false for .ps1 on Windows (cmd.exe can't run it)", () => {
    // .ps1 is intentionally NOT in the shim list. cmd.exe can't execute
    // PowerShell scripts directly; a real .ps1 install would need a
    // future powershell.exe -File code path.
    assert.equal(needsShellFor("C:\\tools\\claude.ps1", "win32"), false)
  })

  it("returns false for any path on non-Windows platforms", () => {
    assert.equal(needsShellFor("/usr/local/bin/claude", "linux"), false)
    assert.equal(needsShellFor("/usr/local/bin/claude.cmd", "linux"), false)
    assert.equal(needsShellFor("/usr/local/bin/claude.bat", "darwin"), false)
  })

  it("returns false for extensionless binaries", () => {
    assert.equal(needsShellFor("/home/u/.local/bin/claude", "linux"), false)
    assert.equal(needsShellFor("C:\\tools\\claude", "win32"), false)
  })
})

describe("quoteWindowsArg", () => {
  it("wraps plain text in double quotes", () => {
    assert.equal(quoteWindowsArg("hello"), '"hello"')
  })

  it("preserves whitespace inside the quoted arg (the truncation-bug fix)", () => {
    assert.equal(quoteWindowsArg("hello, say hi back"), '"hello, say hi back"')
  })

  it("doubles embedded double quotes (cmd.exe escape convention)", () => {
    assert.equal(quoteWindowsArg('say "hi"'), '"say ""hi"""')
  })

  it("doubles `%` so cmd.exe does not env-expand user input", () => {
    // Without this, `%USERNAME%` in a user prompt would be replaced by cmd.exe
    // before the shim ever sees it.
    assert.equal(quoteWindowsArg("echo %USERNAME%"), '"echo %%USERNAME%%"')
  })

  it("handles a single `%`", () => {
    assert.equal(quoteWindowsArg("50% done"), '"50%% done"')
  })

  it("handles empty string", () => {
    assert.equal(quoteWindowsArg(""), '""')
  })

  it("escapes `%` and `\"` together", () => {
    assert.equal(quoteWindowsArg('say "%FOO%"'), '"say ""%%FOO%%"""')
  })

  it("does not touch other shell metacharacters (they're safe inside double quotes)", () => {
    // & | < > ; ( ) ^ are not special inside double-quoted cmd args.
    assert.equal(quoteWindowsArg("a & b | c"), '"a & b | c"')
    assert.equal(quoteWindowsArg("(group) ^and^ more"), '"(group) ^and^ more"')
  })
})
