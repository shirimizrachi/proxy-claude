import type { CliOptions } from "./types.ts"
import { EFFORT_ORDER } from "./translate.ts"

const AGENCY_FALSE_VALUES = new Set(["false", "no"])
const AGENCY_KNOWN_VALUES = new Set(["true", "yes", "false", "no"])
// Valid --effort values: the canonical hierarchy plus the "auto" sentinel
// (which clears any configured floor). Single-sourced from translate.ts so a
// new tier only needs to be added in one place.
const EFFORT_VALUES = new Set<string>(["auto", ...EFFORT_ORDER])

function isAgencyDisabledValue(value: string): boolean {
  return AGENCY_FALSE_VALUES.has(value.toLowerCase())
}

export function parseCliArgs(args: string[]): CliOptions {
  const separatorIndex = args.indexOf("--")
  const proxyArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const explicitPassthrough =
    separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)

  let useAgency = true
  let resetModels = false
  let effort: string | undefined
  const claudeArgs: string[] = []

  let index = 0
  while (index < proxyArgs.length) {
    const arg = proxyArgs[index]
    if (arg === "--agency") {
      const next = proxyArgs[index + 1]
      if (next && AGENCY_KNOWN_VALUES.has(next.toLowerCase())) {
        useAgency = !isAgencyDisabledValue(next)
        index += 2
      } else {
        useAgency = true
        index++
      }
    } else if (arg.startsWith("--agency=")) {
      useAgency = !isAgencyDisabledValue(arg.slice("--agency=".length))
      index++
    } else if (arg === "--reset-models") {
      resetModels = true
      index++
    } else if (arg === "--yolo") {
      index++
    } else if (arg.startsWith("--effort=")) {
      const value = arg.slice("--effort=".length).toLowerCase()
      if (EFFORT_VALUES.has(value)) {
        effort = value
      } else {
        console.error(`[proxyClaude] Unknown effort level: "${value}". Valid: ${[...EFFORT_VALUES].join(", ")}`)
      }
      index++
    } else if (arg === "--effort") {
      const next = proxyArgs[index + 1]
      if (next && EFFORT_VALUES.has(next.toLowerCase())) {
        effort = next.toLowerCase()
        index += 2
      } else {
        console.error(`[proxyClaude] --effort requires a value. Valid: ${[...EFFORT_VALUES].join(", ")}`)
        index++
      }
    } else {
      claudeArgs.push(arg)
      index++
    }
  }

  return {
    useAgency,
    resetModels,
    effort,
    passthroughArgs: [...claudeArgs, ...explicitPassthrough],
  }
}
