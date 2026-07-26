import type { FilesApi } from "@statewalker/webrun-files";
import { writeText } from "@statewalker/webrun-files";

/**
 * The payload (`src/app/**`) is authored as real, typechecked TS/TSX and shipped
 * into the workspace as raw bytes — the runner never imports payload logic. The
 * glob keys (`./app/server/index.ts`) are mapped to workspace paths
 * (`/server/index.ts`); the payload's own `tsconfig.json` is not part of the app.
 */
const rawEntries = import.meta.glob("./app/**/*", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

function buildSeed(entries: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, content] of Object.entries(entries)) {
    if (key.split("/").pop() === "tsconfig.json") continue; // not part of the app
    out[key.replace(/^\.\/app/, "")] = content;
  }
  return out;
}

/** Workspace-path → file-content map of the bundled payload. */
export const seed: Record<string, string> = buildSeed(rawEntries);

/**
 * Idempotent workspace initialization: if `/package.json` is absent, write the
 * whole seed; otherwise leave the workspace untouched. Never writes under
 * `/data` (user note storage).
 */
export async function ensureWorkspace(
  files: FilesApi,
  entries: Record<string, string> = seed,
): Promise<void> {
  if (await files.exists("/package.json")) return;
  for (const [path, content] of Object.entries(entries)) {
    if (path.startsWith("/data/")) continue;
    await writeText(files, path, content);
  }
}
