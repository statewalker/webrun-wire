import type { FilesApi } from "@statewalker/webrun-files";
import { getOPFSFilesApi } from "@statewalker/webrun-files-browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

/**
 * The storage seam: the workspace `FilesApi` backend is chosen once at boot.
 * `"mem"` (default) is ephemeral; `"opfs"` persists across reloads (requires a
 * secure context — localhost qualifies).
 */

export type StorageKind = "mem" | "opfs";

/** Parse the backend from a `#storage=opfs` location hash; default `"mem"`. */
export function storageKindFromHash(hash: string): StorageKind {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return params.get("storage") === "opfs" ? "opfs" : "mem";
}

export async function createWorkspace(kind: StorageKind): Promise<FilesApi> {
  return kind === "opfs" ? getOPFSFilesApi() : new MemFilesApi();
}
