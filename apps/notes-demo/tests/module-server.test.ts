import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer, type PackageManifest, type Source } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { deriveLock } from "../src/derive-lock.ts";

/**
 * Hermetic proof of criteria 2/5/6 with a synthetic (non-notes) payload: the
 * runner path (deriveLock + newModuleServer) transpiles authored TS, rewrites a
 * local `./b.ts` import to a same-origin URL, and resolves a bare dep same-origin
 * — no network, no CDN, no import map. Proves the runner is payload-agnostic.
 */

/** In-memory Source: serves fixed packages from a map (no network). */
function memSource(
  pkgs: Record<string, { version: string; files: Record<string, string> }>,
): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const p = pkgs[ref.pkg];
      const files = new MemFilesApi();
      for (const [path, content] of Object.entries(p.files))
        await writeText(files, `/${path}`, content);
      return {
        name: ref.pkg,
        version: p.version,
        files,
        manifest: {
          name: ref.pkg,
          version: p.version,
          type: "module",
          main: "./index.js",
        } as PackageManifest,
      };
    },
  };
}

async function makeProject(): Promise<MemFilesApi> {
  const project = new MemFilesApi();
  await writeText(
    project,
    "/package.json",
    JSON.stringify({ type: "module", dependencies: { dep: "^1.0.0" } }),
  );
  await writeText(
    project,
    "/a.ts",
    `import { b } from "./b.ts";\nimport { d } from "dep";\nexport const x: number = b + d;`,
  );
  await writeText(project, "/b.ts", `export const b: number = 1;`);
  return project;
}

describe("runner module-server path", () => {
  it("transpiles TS, rewrites ./b.ts local import + bare dep to same-origin URLs", async () => {
    const project = await makeProject();
    const lock = await deriveLock(project); // exact { dep: "1.0.0" }
    expect(lock).toEqual({ dep: "1.0.0" });

    const server = newModuleServer({
      cache: new MemFilesApi(),
      sources: [
        memSource({ dep: { version: "1.0.0", files: { "index.js": "export const d = 2;" } } }),
      ],
      project,
      target: "browser",
      lock,
    });

    const res = await server.fetch(new Request("http://site/~/a.ts"));
    expect(res.headers.get("content-type")).toBe("text/javascript");
    const js = await res.text();

    // TS stripped.
    expect(js).not.toContain(": number");
    // Local relative import keeps its explicit extension, same-origin (relative).
    expect(js).toContain(`from "./b.ts"`);
    // Bare dep resolved to a same-origin, pinned, relative URL — not a bare specifier.
    expect(js).toContain(`from "../dep@1.0.0/index.js"`);
    expect(js).not.toContain(`from "dep"`);
    // No CDN host and no import map anywhere.
    expect(js).not.toMatch(/esm\.sh|jsdelivr|unpkg|registry\.npmjs/);

    // The rewritten dep URL is actually served (same-origin), transpiled JS.
    const dep = await server.fetch(new Request("http://site/dep@1.0.0/index.js"));
    expect(dep.status).toBe(200);
    expect(dep.headers.get("content-type")).toBe("text/javascript");
    expect(await dep.text()).toContain("export const d = 2");
  });
});
