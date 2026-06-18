import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { parseCliArgs } from "../src/cli-options.ts"

describe("parseCliArgs", () => {
  it("uses agency by default", () => {
    const parsed = parseCliArgs([])
    assert.equal(parsed.useAgency, true)
  })

  it("keeps --agency compatibility", () => {
    const parsed = parseCliArgs(["--agency"])
    assert.equal(parsed.useAgency, true)
  })

  it("allows opting out with --agency false", () => {
    const parsed = parseCliArgs(["--agency", "false"])
    assert.equal(parsed.useAgency, false)
  })

  it("allows opting out with --agency no", () => {
    const parsed = parseCliArgs(["--agency", "no"])
    assert.equal(parsed.useAgency, false)
  })

  it("allows opting out with --agency=false", () => {
    const parsed = parseCliArgs(["--agency=false"])
    assert.equal(parsed.useAgency, false)
  })

  it("preserves passthrough args", () => {
    const parsed = parseCliArgs(["--agency", "--", "--print", "hello"])
    assert.deepEqual(parsed.passthroughArgs, ["--print", "hello"])
  })

  it("handles --agency true without leaking to passthrough", () => {
    const parsed = parseCliArgs(["--agency", "true"])
    assert.equal(parsed.useAgency, true)
    assert.deepEqual(parsed.passthroughArgs, [])
  })

  it("allows opting out with --agency=no", () => {
    const parsed = parseCliArgs(["--agency=no"])
    assert.equal(parsed.useAgency, false)
  })

  it("does not swallow unrecognized values after --agency", () => {
    const parsed = parseCliArgs(["--agency", "someValue"])
    assert.equal(parsed.useAgency, true)
    assert.deepEqual(parsed.passthroughArgs, ["someValue"])
  })

  it("parses --effort=max", () => {
    const parsed = parseCliArgs(["--effort=max"])
    assert.equal(parsed.effort, "max")
  })

  it("parses --effort high (space-separated)", () => {
    const parsed = parseCliArgs(["--effort", "high"])
    assert.equal(parsed.effort, "high")
  })

  it("parses --effort=auto", () => {
    const parsed = parseCliArgs(["--effort=auto"])
    assert.equal(parsed.effort, "auto")
  })

  it("parses --effort=xhigh", () => {
    const parsed = parseCliArgs(["--effort=xhigh"])
    assert.equal(parsed.effort, "xhigh")
  })

  it("ignores invalid effort values", () => {
    const parsed = parseCliArgs(["--effort=banana"])
    assert.equal(parsed.effort, undefined)
  })

  it("does not consume next arg on bare --effort without valid value", () => {
    const parsed = parseCliArgs(["--effort", "--resume"])
    assert.equal(parsed.effort, undefined)
    assert.deepEqual(parsed.passthroughArgs, ["--resume"])
  })

  it("effort defaults to undefined", () => {
    const parsed = parseCliArgs([])
    assert.equal(parsed.effort, undefined)
  })
})
