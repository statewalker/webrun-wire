/**
 * What a consumer's bundle keeps of the BUILT package.
 *
 * Each entry of `dist/` is one self-contained file with the HTTP stack inlined
 * (webrun-http-streams' codec, webrun-rpc's links). A module-level `const x =
 * makeCodec()` in one of them is a call a bundler must keep, with everything it
 * reaches, unless it is annotated pure — which is how a page that only opens
 * WebSockets came to carry the whole HTTP/1.1 codec, about 16 KB minified. So
 * this bundles a few imports from `dist/` with rolldown, as a consumer's Vite
 * build would, and checks what came along.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { afterAll, describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
let dir: string | undefined;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** The minified bundle of `import { names } from "<dist>/<entry>.js"`. */
async function bundle(entry: string, names: string[]): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), "webrun-http-browser-shake-"));
  const input = join(dir, `${entry}-${names.join("-")}.js`);
  await writeFile(
    input,
    `import { ${names.join(", ")} } from ${JSON.stringify(join(dist, `${entry}.js`))};\n` +
      `console.log(${names.join(", ")});\n`,
  );
  const build = await rolldown({ input, platform: "browser", logLevel: "silent" });
  try {
    const { output } = await build.generate({ format: "esm", minify: true });
    return output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
  } finally {
    await build.close();
  }
}

/** Traces of the HTTP stack: the HTTP/1.1 codec and its parse errors. */
const hasHttpStack = (code: string) => code.includes("HTTP/1.1") || code.includes("HttpParseError");

describe("tree-shaking the built entries", () => {
  it("the probe sees the HTTP stack where it is used", async () => {
    const code = await bundle("sw", ["connectHttpLink"]);
    expect(hasHttpStack(code)).toBe(true);
  });

  for (const entry of ["sw", "worker", "index"]) {
    it(`the WebSocket client from ./${entry === "index" ? "" : entry} carries no HTTP stack`, async () => {
      const code = await bundle(entry, ["createWebSocketClass"]);
      expect(hasHttpStack(code)).toBe(false);
      // Its own code is about 7 KB minified.
      expect(code.length).toBeLessThan(12_000);
    });
  }

  it("the server end and the upgrade carry no HTTP stack", async () => {
    const code = await bundle("sw", ["upgradeWebSocket", "ServerWebSocket", "isWebSocketUpgrade"]);
    expect(hasHttpStack(code)).toBe(false);
    expect(code.length).toBeLessThan(12_000);
  });

  it("the lock and rendezvous helpers carry no HTTP stack", async () => {
    const code = await bundle("sw", ["holdLock", "watchLock", "PortRendezvous"]);
    expect(hasHttpStack(code)).toBe(false);
  });
});
