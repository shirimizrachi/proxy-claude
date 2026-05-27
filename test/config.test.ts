import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { isNewerVersion } from "../src/config.ts"

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
