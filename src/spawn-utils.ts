/**
 * Helpers for cross-platform process spawn used by spawnClaude.
 *
 * Extracted so the OS-dependent decisions (which extensions require a shell,
 * how to quote args for cmd.exe) can be unit-tested without actually
 * spawning a process or depending on the current platform.
 */

const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat"] as const

/**
 * Return true when `resolvedPath` must be spawned with `shell: true` on the
 * given platform. The only case that requires shell:true is a Windows .cmd /
 * .bat shim — Node 18.20+/20.12+ refuses to spawn those with shell:false as
 * a CVE-2024-27980 mitigation. Native .exe / Unix executables MUST use
 * shell:false so libuv passes argv through verbatim (this is the fix for
 * the original truncation bug).
 *
 * .ps1 intentionally excluded: cmd.exe cannot execute PowerShell scripts
 * directly. Future support would spawn powershell.exe -File explicitly.
 */
export function needsShellFor(
  resolvedPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") return false
  const lower = resolvedPath.toLowerCase()
  return WINDOWS_SHIM_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Quote a single argument for cmd.exe. Wraps in double quotes, doubles
 * embedded double quotes (cmd.exe convention), and doubles `%` so cmd.exe
 * does not env-expand user input (e.g. a prompt containing `%USERNAME%`
 * would otherwise be replaced before the shim ever sees it). Only used on
 * the shell:true path — the shell:false path doesn't need this because
 * Node's libuv applies correct Windows arg-quoting automatically for arrays.
 */
export function quoteWindowsArg(a: string): string {
  return `"${a.replace(/%/g, "%%").replace(/"/g, '""')}"`
}
