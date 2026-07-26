import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { ensureWorkspace, seed } from "../src/seed.ts";

describe("seed mapping", () => {
  it("maps ./app/<path> to workspace /<path> and excludes the payload tsconfig", () => {
    expect(seed["/package.json"]).toBeDefined();
    expect(seed["/server/index.ts"]).toContain("export default");
    expect(seed["/client/index.html"]).toContain('<div id="app">');
    expect(seed["/client/main.tsx"]).toContain("react-dom/client");
    // The payload's own tsconfig must NOT be seeded into the workspace.
    expect(seed["/tsconfig.json"]).toBeUndefined();
    for (const key of Object.keys(seed)) {
      expect(key.startsWith("/")).toBe(true);
      expect(key.endsWith("/tsconfig.json")).toBe(false);
    }
  });
});

describe("ensureWorkspace", () => {
  it("seeds every payload file into an empty workspace and records the version", async () => {
    const files = new MemFilesApi();
    expect(await ensureWorkspace(files)).toBe(true);
    expect(await files.exists("/package.json")).toBe(true);
    expect(await files.exists("/server/index.ts")).toBe(true);
    expect(await files.exists("/client/main.tsx")).toBe(true);
    expect(await files.exists("/.seed-version")).toBe(true);
  });

  it("is a no-op (and leaves source edits intact) when the version already matches", async () => {
    const files = new MemFilesApi();
    expect(await ensureWorkspace(files)).toBe(true);
    await writeText(files, "/client/main.tsx", "// user tweak");
    expect(await ensureWorkspace(files)).toBe(false); // same seed → skip
    expect(await readText(files, "/client/main.tsx")).toBe("// user tweak");
  });

  it("re-seeds source when the payload version changes, preserving /data", async () => {
    const files = new MemFilesApi();
    const v1 = { "/package.json": "{}", "/client/main.tsx": "v1" };
    expect(await ensureWorkspace(files, v1)).toBe(true);
    await writeText(files, "/data/notes/keep.md", "kept body"); // user note

    const v2 = { "/package.json": "{}", "/client/main.tsx": "v2 CHANGED" };
    expect(await ensureWorkspace(files, v2)).toBe(true); // different version → re-seed
    expect(await readText(files, "/client/main.tsx")).toBe("v2 CHANGED"); // source refreshed
    expect(await readText(files, "/data/notes/keep.md")).toBe("kept body"); // /data untouched
  });
});
