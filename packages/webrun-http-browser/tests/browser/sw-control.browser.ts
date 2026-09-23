/**
 * Real-browser tests for the ServiceWorker start-up path, in Chromium and
 * Firefox, driven by Playwright against the BUILT bundles (`dist/`), which is
 * what consumers load. Run with `pnpm test:browser` (it builds first).
 *
 * The defect these pin: `SwHttpAdapter.start()` and the relay page's
 * `initServiceWorker` waited for `navigator.serviceWorker.controller` with no
 * bound, resolving only on `controllerchange`. A page can be uncontrolled
 * while the worker is active, and then nothing ever fires:
 *
 * - a hard reload (Ctrl+Shift+R) bypasses the worker for that load, and the
 *   worker's `clients.claim()` already ran when it activated;
 * - Firefox has been seen to leave a second page of a running worker
 *   uncontrolled (the httpeers session shell, 2026-09-18). This harness does
 *   not reproduce that — here Firefox controls a second tab and a normal
 *   reload — so the hard reload stands in for every "uncontrolled" cause.
 *
 * Relay mode needs no control, only a worker to message: an uncontrolled
 * relay page bridges to `registration.active`. Chromium's cache-bypassing
 * reload does not bypass the worker for the relay iframe, so the relay page is
 * also hard-reloaded on its own.
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
const SAME_ORIGIN = "/tests/fixtures/browser/same-origin/index.html";
const RELAY = "/tests/fixtures/browser/relay/index.html";

/** How long a scenario may take before the test calls it hung. */
const HANG_MS = 8_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

let server: Server;
let origin: string;

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
  ok?: boolean;
  hung?: boolean;
  status?: number;
  body?: string;
  controlled?: boolean;
  relayControlled?: boolean;
  name?: string;
  reason?: string;
  message?: string;
  ms?: number;
}

/** The page's `window.result`, or `{ hung: true }` if it has not settled in `HANG_MS`. */
async function outcome(page: Page): Promise<Outcome> {
  await page.waitForFunction(() => "result" in window);
  return (await page.evaluate(
    (hangMs) =>
      Promise.race([
        (window as unknown as { result: Promise<unknown> }).result,
        new Promise((resolve) => setTimeout(() => resolve({ hung: true }), hangMs)),
      ]),
    HANG_MS,
  )) as Outcome;
}

async function initiallyControlled(page: Page): Promise<boolean> {
  return (await page.evaluate("window.initiallyControlled")) as boolean;
}

/**
 * A hard reload — the load bypasses the ServiceWorker. Chromium: DevTools'
 * cache-bypassing reload, the same load type as Ctrl+Shift+R. Firefox:
 * `location.reload(true)`, whose non-standard `forceGet` is Firefox's bypass.
 */
async function hardReload(page: Page, browserName: string, context: BrowserContext): Promise<void> {
  const loaded = page.waitForEvent("load");
  if (browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.reload", { ignoreCache: true });
  } else {
    await page.evaluate("location.reload(true)");
  }
  await loaded;
}

/**
 * Talks to the shipped relay page from inside it, the way
 * `newRemoteRelayChannel`'s parent does: hand it a port with a CONNECT
 * message, register a service over the port, call it.
 */
async function connectDirectly(page: Page): Promise<Outcome> {
  // A string, not a function: vitest's transform would rewrite a function's
  // `import()` into a helper that does not exist in the page.
  return (await page.evaluate(`(async () => {
    const lib = await import(location.origin + "/dist/index.js");
    const channel = new MessageChannel();
    window.postMessage({ type: "CONNECT" }, "*", [channel.port1]);
    const port = channel.port2;
    const run = (async () => {
      await lib.initHttpService(async () => new Response("direct"), { key: "D", port });
      const request = new Request(location.origin + "/public-relay/~D/x");
      const response = await lib.callHttpService(request, { key: "D", port });
      return { ok: true, status: response.status, body: await response.text() };
    })();
    return await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ${HANG_MS})),
    ]);
  })()`)) as Outcome;
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

    async function freshPage(): Promise<Page> {
      await context?.close();
      context = await browser.newContext();
      return await context.newPage();
    }

    describe("same-origin SwHttpAdapter", () => {
      const expectServed = (result: Outcome) => {
        expect(result).toMatchObject({
          ok: true,
          status: 200,
          body: "hello /tests/fixtures/browser/same-origin/t/x",
          controlled: true,
        });
      };

      it("first visit: installs, takes control, serves", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${SAME_ORIGIN}`);
        expect(await initiallyControlled(page)).toBe(false);
        expectServed(await outcome(page));
      });

      it("normal reload", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${SAME_ORIGIN}`);
        expectServed(await outcome(page));
        await page.reload();
        expectServed(await outcome(page));
      });

      it("hard reload: the page starts uncontrolled and is taken over", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${SAME_ORIGIN}`);
        expectServed(await outcome(page));
        await hardReload(page, browserName, context);
        // Proves the scenario is real: the worker is active, the page is not controlled.
        expect(await initiallyControlled(page)).toBe(false);
        expectServed(await outcome(page));
      });

      it("second tab", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${SAME_ORIGIN}`);
        expectServed(await outcome(page));
        const second = await context.newPage();
        await second.goto(`${origin}${SAME_ORIGIN}`);
        expectServed(await outcome(second));
      });

      it("a worker that never activates: rejects with a timeout error", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${SAME_ORIGIN}?sw=./hang-sw.js&timeout=1000`);
        const result = await outcome(page);
        expect(result).toMatchObject({
          ok: false,
          name: "ServiceWorkerControlError",
          reason: "activation-timeout",
        });
        expect(result.message).toMatch(/did not activate within 1000 ms/);
        expect(result.ms).toBeLessThan(HANG_MS);
      });

      it("a controlling worker that never answers the handshake: rejects as unresponsive", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${SAME_ORIGIN}?sw=./silent-sw.js&timeout=1000`);
        const result = await outcome(page);
        expect(result).toMatchObject({
          ok: false,
          name: "ServiceWorkerControlError",
          reason: "unresponsive",
        });
        expect(result.message).toMatch(/UPDATE_COMMUNICATION_PORT handshake within 1000 ms/);
      });

      it("an uncontrolled page and a worker that will not claim it: rejects, naming the hard reload", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${SAME_ORIGIN}?sw=./legacy-sw.js&timeout=1000`);
        await outcome(page);
        await hardReload(page, browserName, context);
        expect(await initiallyControlled(page)).toBe(false);
        const result = await outcome(page);
        expect(result).toMatchObject({
          ok: false,
          name: "ServiceWorkerControlError",
          reason: "uncontrolled",
        });
        expect(result.message).toMatch(/hard reload/);
        expect(result.message).toMatch(/reloadIfUncontrolled/);
        expect(result.ms).toBeLessThan(HANG_MS);
      });

      it("reloadIfUncontrolled: reloads once, and the reloaded page is served", async () => {
        const page = await freshPage();
        const url = `${origin}${SAME_ORIGIN}?sw=./legacy-sw.js&timeout=1000&reload`;
        await page.goto(url);
        await outcome(page);
        const navigations: string[] = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) navigations.push(frame.url());
        });
        await hardReload(page, browserName, context);
        await expect.poll(() => navigations.length, { timeout: HANG_MS }).toBe(2);
        await page.waitForLoadState("load");
        const result = await outcome(page);
        // The hard reload, then exactly one reload of the library's own: a
        // normal reload is a controlled navigation, so the page recovers.
        expect(navigations.length).toBe(2);
        expect(result).toMatchObject({ ok: true, controlled: true });
      });

      it("reloadIfUncontrolled: when the reloaded page is uncontrolled too, rejects instead of looping", async () => {
        const page = await freshPage();
        const url = `${origin}${SAME_ORIGIN}?sw=./legacy-sw.js&timeout=1000&reload`;
        await page.goto(url);
        await outcome(page);
        // Simulate a reload that comes back uncontrolled: the guard is already set.
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          sessionStorage.setItem(
            `webrun-http-browser:reloaded-uncontrolled:${registration?.scope}`,
            "1",
          );
        });
        const navigations: string[] = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) navigations.push(frame.url());
        });
        await hardReload(page, browserName, context);
        const result = await outcome(page);
        expect(navigations.length).toBe(1);
        expect(result).toMatchObject({ ok: false, reason: "uncontrolled" });
      });
    });

    describe("relay", () => {
      const expectRelayed = (result: Outcome) => {
        expect(result).toMatchObject({ ok: true, status: 200, body: "relayed /public-relay/~K/x" });
      };

      it("first visit", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${RELAY}`);
        expectRelayed(await outcome(page));
      });

      it("normal reload", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${RELAY}`);
        expectRelayed(await outcome(page));
        await page.reload();
        expectRelayed(await outcome(page));
      });

      it("hard reload", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${RELAY}`);
        expectRelayed(await outcome(page));
        await hardReload(page, browserName, context);
        expectRelayed(await outcome(page));
      });

      it("the relay page itself, hard-reloaded: bridges to the active worker", async () => {
        const page = await freshPage();
        await page.goto(`${origin}/public-relay/relay.html`);
        // The relay page registers its worker on the first CONNECT.
        expect(await connectDirectly(page)).toMatchObject({ ok: true, body: "direct" });
        await hardReload(page, browserName, context);
        // Proves the scenario: the relay page is not controlled.
        expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);
        expect(await connectDirectly(page)).toMatchObject({
          ok: true,
          status: 200,
          body: "direct",
        });
      });

      it("second tab", async () => {
        const page = await freshPage();
        await page.goto(`${origin}${RELAY}`);
        expectRelayed(await outcome(page));
        const second = await context.newPage();
        await second.goto(`${origin}${RELAY}?key=K`);
        expectRelayed(await outcome(second));
      });
    });

    afterAll(async () => {
      await context?.close();
    });
  });
}
