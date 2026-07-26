import type { FilesApi } from "@statewalker/webrun-files";
import { readText } from "@statewalker/webrun-files";
import type { Lockfile } from "@statewalker/webrun-modules";

/**
 * Derive a module-server lockfile from the workspace `package.json`. The lock is
 * app-agnostic (the runner reads it from the payload, not from hardcoded names)
 * and MUST be **exact**: the module server's cache key is the pinned version, so
 * a range like `^18.3.1` would resolve to a different id than requested and 404.
 */

/** Strip range operators (`^ ~ >= > <= < =`) to the first concrete version token. */
export function toExactVersion(range: string): string {
  const stripped = range.trim().replace(/^[\s^~>=<]+/, "");
  return stripped.split(/\s+/)[0] || range.trim();
}

export async function deriveLock(files: FilesApi): Promise<Lockfile> {
  const manifest = JSON.parse(await readText(files, "/package.json")) as {
    dependencies?: Record<string, string>;
  };
  const lock: Lockfile = {};
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    lock[name] = toExactVersion(range);
  }
  return lock;
}
