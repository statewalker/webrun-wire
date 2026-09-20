/**
 * What the PUBLISHED package actually hands a consumer.
 *
 * Runs under `test:browser`, which builds first — these assertions are about
 * `dist/`, not `src/`, and a subpath that resolves in the workspace can still
 * be missing from the tarball. Two things have gone wrong here before: a
 * function the README told hosts to call was reachable from no subpath at
 * all, and a subpath shipped without declarations, so no consumer could type
 * its arguments.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../../", import.meta.url);

async function manifest(): Promise<{
  exports: Record<string, Record<string, string>>;
  files: string[];
}> {
  return JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
}

describe("the package's exports map", () => {
  it("every target exists in dist", async () => {
    const { exports } = await manifest();
    const missing: string[] = [];
    for (const [subpath, target] of Object.entries(exports)) {
      for (const file of Object.values(target)) {
        if (!existsSync(new URL(file, packageRoot))) missing.push(`${subpath} → ${file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("ships the relay worker runtime as a typed subpath", async () => {
    const { exports } = await manifest();
    expect(exports["./relay-worker"]).toEqual({
      types: "./dist/relay-worker.d.ts",
      import: "./dist/relay-worker.js",
    });

    const module = await import(fileURLToPath(new URL("dist/relay-worker.js", packageRoot)));
    expect(typeof module.startRelayServiceWorker).toBe("function");

    // The types a host needs to write the options, not just the function.
    const declaration = await readFile(new URL("dist/relay-worker.d.ts", packageRoot), "utf8");
    expect(declaration).toMatch(/RelayServiceWorkerOptions/);
    expect(declaration).toMatch(/MountSpec/);
    expect(declaration).toMatch(/startRelayServiceWorker/);
  });
});
