/**
 * Mounts, in real browsers, against the BUILT bundles.
 *
 * Everything below goes through `dist/relay-sw.js` loaded by `importScripts`
 * from the fixture's own worker, which is how a host ships this: the worker
 * script sets `self.RELAY_OPTIONS` and then loads the bundle. Nothing here
 * imports the source.
 *
 * What these pin, and why each one is here:
 *
 *   - a service mounted at the scope root answers that root, which is the
 *     whole point of mounts: root-absolute URLs inside the origin reach the
 *     host, with no `/~<key>/` prefix;
 *   - a catch-all mount answers a path with no file behind it, so a host can
 *     serve routes that exist only in its own router;
 *   - a second mount one level down is not swallowed by that catch-all --
 *     longest prefix wins, whatever the registration order;
 *   - an EXCLUDED path still comes from the network. A root mount claims every
 *     path, so without `exclude` a host cannot serve its own files -- and the
 *     relay page and worker script are two of them, so getting this wrong
 *     means the origin cannot bootstrap at all;
 *   - `?q=~foo` is a query, not a service (Task 1), end to end;
 *   - the mounts survive a reload of the host page.
 *
 * SCOPE. The fixture worker is served from `tests/fixtures/browser/mounts/`,
 * so its scope is that directory and the paths it sees are
 * `/tests/fixtures/browser/mounts/...`. The mounts and every assertion are
 * written in those terms; `/` would be a different (and here unregisterable)
 * scope.
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

/** The scope of the fixture worker, and so the root mount. */
const BASE = "/tests/fixtures/browser/mounts/";
const HOST = `${BASE}index.html`;

/** How long a scenario may take before the test calls it hung. */
const HANG_MS = 15_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

let server: Server;
let origin: string;

// The same static server as `sw-control.browser.ts`: the package root over
// HTTP, so `/dist/...` and `/tests/fixtures/...` are absolute paths of one
// origin. Kept self-contained rather than shared, so that file's 28 tests are
// untouched by this one.
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

interface Ready {
  ok?: boolean;
  controlled?: boolean;
  hung?: boolean;
  name?: string;
  message?: string;
  ms?: number;
}

interface Fetched {
  status?: number;
  body?: string;
  hung?: boolean;
}

/** The fixture's `window.ready`, or `{ hung: true }` if it has not settled. */
async function ready(page: Page): Promise<Ready> {
  await page.waitForFunction(() => "ready" in window);
  return (await page.evaluate(
    (hangMs) =>
      Promise.race([
        (window as unknown as { ready: Promise<unknown> }).ready,
        new Promise((resolve) => setTimeout(() => resolve({ hung: true }), hangMs)),
      ]),
    HANG_MS,
  )) as Ready;
}

/**
 * A `fetch` made BY THE PAGE, which is the only way the ServiceWorker sees it:
 * a request issued from the test harness would never reach the worker.
 */
async function fetched(page: Page, path: string): Promise<Fetched> {
  return (await page.evaluate(
    ([target, hangMs]) =>
      Promise.race([
        (async () => {
          const response = await fetch(target as string);
          return { status: response.status, body: await response.text() };
        })(),
        new Promise((resolve) => setTimeout(() => resolve({ hung: true }), hangMs as number)),
      ]),
    [path, HANG_MS] as [string, number],
  )) as Fetched;
}

const browsers = { chromium, firefox };

for (const [browserName, browserType] of Object.entries(browsers)) {
  describe(`${browserName}`, () => {
    let browser: Browser;
    let context: BrowserContext;

    beforeAll(async () => {
      browser = await browserType.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    /** A fresh context — no registrations, no IndexedDB — with the host page open and serving. */
    async function openHost(): Promise<Page> {
      await context?.close();
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${origin}${HOST}`);
      // The first visit registers the worker, so the page starts uncontrolled:
      // proves the mounts below are not an artefact of a warm registration.
      expect(await page.evaluate("window.initiallyControlled")).toBe(false);
      expect(await ready(page)).toMatchObject({ ok: true, controlled: true });
      return page;
    }

    it("the mount root answers", async () => {
      const page = await openHost();
      expect(await fetched(page, BASE)).toEqual({ status: 200, body: `app:${BASE}` });
    });

    it("a catch-all mount answers a path with no file behind it", async () => {
      const page = await openHost();
      expect(await fetched(page, `${BASE}no-such-file.html`)).toEqual({
        status: 200,
        body: `app:${BASE}no-such-file.html`,
      });
    });

    it("the longer prefix wins over the catch-all", async () => {
      const page = await openHost();
      expect(await fetched(page, `${BASE}peers/12D3Koo/llm`)).toEqual({
        status: 200,
        body: `mesh:${BASE}peers/12D3Koo/llm`,
      });
    });

    it("an excluded path comes from the network, not from the root mount", async () => {
      const page = await openHost();
      const result = await fetched(page, `${BASE}reserved.txt`);
      expect(result.status).toBe(200);
      expect(result.body?.trim()).toBe("from the network");
    });

    it("?q=~foo is a query, not a service", async () => {
      const page = await openHost();
      expect(await fetched(page, `${BASE}page.html?q=~foo`)).toEqual({
        status: 200,
        body: `app:${BASE}page.html`,
      });
    });

    it("the mounts survive a reload of the host page", async () => {
      const page = await openHost();
      const target = `${BASE}peers/12D3Koo/llm`;
      const expected = { status: 200, body: `mesh:${target}` };
      expect(await fetched(page, target)).toEqual(expected);

      // The registration outlives the page, so the reload happens with the
      // worker already running.
      //
      // THE RELOADED PAGE IS NOT NECESSARILY CONTROLLED, and that is the
      // worker doing the right thing: this page is EXCLUDED, so the worker
      // does not answer its navigation at all (it must not -- a page the host
      // reserved has to come from the network). Chromium controls it anyway;
      // Firefox does not, and nothing would ever claim it, which is exactly
      // the case `awaitServiceWorkerControl` exists for -- the fixture calls
      // it, and the mounts answer either way. A page SERVED by a mount is a
      // navigation the worker answers, so it is controlled from its first
      // byte and needs none of this.
      const registered = await page.evaluate(async () => {
        return !!(await navigator.serviceWorker.getRegistration());
      });
      expect(registered).toBe(true);
      await page.reload();
      expect(await ready(page)).toMatchObject({ ok: true, controlled: true });
      expect(await fetched(page, target)).toEqual(expected);
    });

    afterAll(async () => {
      await context?.close();
    });
  });
}
