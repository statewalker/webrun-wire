/**
 * The Node profile: routes on disk.
 *
 * Write-then-rename, for the same reason the identity store does it — a
 * truncated file is not a corrupt file somebody notices, it is a table that
 * silently loses routes. Here the cost is smaller than a lost mesh identity,
 * but the fix is two lines and the failure is equally quiet.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertNoSecrets, type RouteStore, type StoredRoute } from "./store.js";

export function fileRouteStore(path: string): RouteStore {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as StoredRoute[];
      } catch (error) {
        // NEVER WRITTEN, not empty. A first run seeds its defaults; a run
        // after the operator deleted every route must not resurrect them.
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(routes) {
      assertNoSecrets(routes);
      await mkdir(dirname(path), { recursive: true });
      const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(staging, JSON.stringify(routes, null, 2), { mode: 0o600 });
      await rename(staging, path);
    },
  };
}
