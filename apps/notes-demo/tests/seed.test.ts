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
  it("seeds every payload file into an empty workspace", async () => {
    const files = new MemFilesApi();
    await ensureWorkspace(files);
    expect(await files.exists("/package.json")).toBe(true);
    expect(await files.exists("/server/index.ts")).toBe(true);
    expect(await files.exists("/client/main.tsx")).toBe(true);
  });

  it("is a no-op when /package.json already exists", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/package.json", '{"existing":true}');
    await ensureWorkspace(files);
    // Untouched: our marker manifest is still there, no payload file written.
    expect(await readText(files, "/package.json")).toBe('{"existing":true}');
    expect(await files.exists("/server/index.ts")).toBe(false);
  });

  it("preserves a pre-existing /data note (never touches /data), but still seeds", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/data/notes/keep.md", "kept body");
    // No /package.json yet → seeding runs, but /data is left intact.
    await ensureWorkspace(files);
    expect(await readText(files, "/data/notes/keep.md")).toBe("kept body");
    expect(await files.exists("/package.json")).toBe(true);
  });
});
