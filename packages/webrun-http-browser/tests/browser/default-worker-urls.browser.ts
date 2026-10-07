/**
 * The default worker urls, in real browsers, against the BUILT bundles.
 *
 * `getRelayWindowMessageHandler()` without `swUrl`, and `SwHttpAdapter`
 * without `serviceWorkerUrl`, each default to a worker script next to the
 * bundle. These pin that the default names a script the build produces —
 * `dist/relay-sw.js` and `dist/sw-worker.js` — and that the browser accepts
 * it as a ServiceWorker with the default scope.
 *
 * Each scenario gets a fresh browser context, so a fresh set of registrations.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, firefox, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const PAGE = "/tests/fixtures/browser/defaults/index.html";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

let server: Server;
let origin: string;

// The same static server as `sw-control.browser.ts`: the package root over
// HTTP, so `/dist/...` and `/tests/fixtures/...` are paths of one origin.
beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = normalize(join(packageRoot, pathname));
    let isFile = false;
    try {
      isFile = file.startsWith(packageRoot) && statSync(file).isFile();
    } catch {}
    if (!isFile) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

interface Outcome {
  ok: boolean;
  scriptURL?: string;
  scope?: string;
  message?: string;
}

// Strings, not functions: vitest's transform would rewrite a function's
// `import()` into a helper that does not exist in the page.

/** Starts the relay handler with no options, the way a CONNECT from the parent does. */
const RELAY_DEFAULTS = `(async () => {
  try {
    const lib = await import(location.origin + "/dist/index.js");
    const handler = lib.getRelayWindowMessageHandler();
    await handler({ data: { type: "CONNECT" }, ports: [new MessageChannel().port1] });
    const [registration] = await navigator.serviceWorker.getRegistrations();
    return { ok: true, scriptURL: registration.active.scriptURL, scope: registration.scope };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
})()`;

/** Registers the worker an adapter with no `serviceWorkerUrl` would register. */
const SAME_ORIGIN_DEFAULTS = `(async () => {
  try {
    const lib = await import(location.origin + "/dist/sw.js");
    const adapter = new lib.SwHttpAdapter({ key: "k", scope: "/dist/" });
    const registration = await navigator.serviceWorker.register(adapter.serviceWorkerUrl, {
      scope: adapter.scope,
    });
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    return { ok: true, scriptURL: worker.scriptURL, scope: registration.scope };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
})()`;

const browsers = { chromium, firefox };

for (const [browserName, browserType] of Object.entries(browsers)) {
  describe(`${browserName}`, () => {
    let browser: Browser;
    let context: BrowserContext;

    beforeAll(async () => {
      browser = await browserType.launch();
    });
    afterAll(async () => {
      await context?.close();
      await browser?.close();
    });

    async function freshPage(): Promise<Page> {
      await context?.close();
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${origin}${PAGE}`);
      return page;
    }

    it("getRelayWindowMessageHandler() registers dist/relay-sw.js by default", async () => {
      const page = await freshPage();
      expect(await page.evaluate(RELAY_DEFAULTS)).toEqual({
        ok: true,
        scriptURL: `${origin}/dist/relay-sw.js`,
        scope: `${origin}/dist/`,
      });
    });

    it("SwHttpAdapter's default worker url is dist/sw-worker.js", async () => {
      const page = await freshPage();
      expect((await page.evaluate(SAME_ORIGIN_DEFAULTS)) as Outcome).toEqual({
        ok: true,
        scriptURL: `${origin}/dist/sw-worker.js`,
        scope: `${origin}/dist/`,
      });
    });
  });
}
