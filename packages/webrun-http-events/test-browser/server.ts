// Fixture HTTP server for the browser test. Plain `node:http` on localhost — that is a secure
// context, so `navigator.serviceWorker.register` works without TLS.
//
// `fixture/main.ts` is TypeScript and imports both a bare specifier
// (`@statewalker/webrun-http-browser/sw`) and package-relative source (`../../src/*.ts`), so it
// cannot be served as-is. It is bundled with esbuild's `build()` API (bundle: true, platform:
// "browser") once, at server start, rather than pre-emitted with tsdown to `fixture/dist/` — one
// less moving part for a fixture this small, and the bundle is rebuilt fresh on every server start
// so it can never go stale.
//
// The ServiceWorker script served at `/sw-worker.js` is `@statewalker/webrun-http-browser`'s own
// published `dist/sw-worker.js`, copied byte-for-byte (not bundled — it is already a self-contained
// IIFE) and served with `Service-Worker-Allowed: /` so it may claim the whole origin.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function bundleMain(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(here, "fixture", "main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no JS output for fixture/main.ts");
  return file.text;
}

async function readSwWorker(): Promise<string> {
  // The package's `exports` map only exposes subpaths it wants used, and
  // `./package.json` is not one of them — resolve the published `./sw-worker`
  // subpath directly instead of reaching in via the package root.
  const swWorkerPath = require.resolve("@statewalker/webrun-http-browser/sw-worker");
  return readFile(swWorkerPath, "utf8");
}

export async function startFixtureServer(port: number): Promise<{ stop: () => Promise<void> }> {
  const [mainJs, swWorkerJs, indexHtml] = await Promise.all([
    bundleMain(),
    readSwWorker(),
    readFile(join(here, "fixture", "index.html"), "utf8"),
  ]);

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexHtml);
      return;
    }
    if (url === "/main.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(mainJs);
      return;
    }
    if (url === "/sw-worker.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "service-worker-allowed": "/",
      });
      res.end(swWorkerJs);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(port, "localhost", resolve));

  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
