/**
 * Handler links through the same-origin ServiceWorker, in a real browser,
 * against the BUILT bundles: streams with backpressure (#32), handlers in
 * Dedicated Workers with routing and hand-over (#33), ServiceWorker restarts
 * and handler deaths (#34), and WebSockets (#35, #36).
 *
 * Chromium and Firefox; the tests that stop the ServiceWorker through CDP, or
 * measure Chromium's own buffer, run in Chromium only.
 *
 * The fixture (tests/fixtures/browser/links/) registers the worker at
 * `links/sw-worker.js`, so the scope is that directory: the page's own
 * handlers serve `links/page/...`, the workers `links/app/...`.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, firefox, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "/tests/fixtures/browser/links/";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext | undefined;

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
  await context?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

/** A fresh context with the fixture page loaded and its adapter started. */
async function open(query = ""): Promise<Page> {
  await context?.close();
  context = await browser.newContext();
  return await openTab(query);
}

async function openTab(query = ""): Promise<Page> {
  const page = await (context as BrowserContext).newPage();
  page.on("pageerror", (error) => console.error("[page]", error));
  await page.goto(`${origin}${BASE}index.html${query}`);
  await page.waitForFunction(() => "ready" in window);
  await page.evaluate("window.ready");
  return page;
}

/** Runs `body` (an async function body, as a string) in the page. */
async function run<T = unknown>(page: Page, body: string): Promise<T> {
  // A string, not a function: vitest's transform would rewrite a function's
  // helpers into names that do not exist in the page.
  return (await page.evaluate(`(async () => { ${body} })()`)) as T;
}

/** Stops every ServiceWorker of the context, as the browser does when one idles out. */
async function stopServiceWorkers(page: Page): Promise<void> {
  const cdp = await (context as BrowserContext).newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.detach();
}

const browsers = { chromium, firefox };

for (const [browserName, browserType] of Object.entries(browsers)) {
  /** Needs Chromium: stops the ServiceWorker through CDP, or measures Chromium's own buffer. */
  const chromiumOnly = browserName === "chromium" ? it : it.skip;

  describe(browserName, () => {
    beforeAll(async () => {
      browser = await browserType.launch();
    });
    afterAll(async () => {
      await context?.close();
      context = undefined;
      await browser?.close();
    });

    describe("streams (#32)", () => {
      it("backpressure: across page, ServiceWorker and worker, the handler stays a few chunks ahead", async () => {
        // A worker reads the page handler's endless stream through the router:
        // page → ServiceWorker → worker, all of it this package's links. (A
        // page's own `fetch` would measure Chromium instead: between a
        // ServiceWorker and a page it buffers tens of megabytes by itself.)
        const page = await open();
        await run(page, `await window.attach("A");`);
        const result = await run<{ read: number; produced: number; cancelled: number }>(
          page,
          `
      const url = new URL("./page/stream", location.href).href;
      const { read } = await window.command("A", { cmd: "read-up", url, n: 60 });
      const produced = window.pageStats.produced;
      for (let i = 0; i < 50 && window.pageStats.cancelled === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return { read, produced, cancelled: window.pageStats.cancelled };
    `,
        );
        expect(result.read).toBe(60);
        expect(result.produced - result.read).toBeLessThanOrEqual(12);
        // The worker's cancel reached the handler, two hops away.
        expect(result.cancelled).toBe(1);
      });

      it("backpressure: a page that stops reading stops the handler; only Chromium buffers", async () => {
        // Between a ServiceWorker's `respondWith` and the page, Chromium buffers
        // a fixed amount by itself (~55 MiB in Chromium 14x, the same for a plain
        // worker with no library). The fixture worker counts what it hands to
        // Chromium (?count), which splits the lead into two parts:
        // - produced - delivered: held by this package; must stay a few chunks;
        // - delivered - read: Chromium's buffer; must stop growing.
        const page = await open("?sw=count");
        const samples = await run<Array<{ produced: number; delivered: number; read: number }>>(
          page,
          `
      const CHUNK = 65536;
      const delivered = () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => resolve(event.data);
          navigator.serviceWorker.controller.postMessage({ type: "delivered" }, [channel.port2]);
        });
      const reader = (await fetch("./page/stream")).body.getReader();
      let read = 0;
      while (read < 64 * CHUNK) read += (await reader.read()).value.byteLength;
      // The reader stops here. Sample until the producer has been still for 2 s.
      const samples = [];
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        samples.push({ produced: window.pageStats.produced * CHUNK, delivered: await delivered(), read });
        const n = samples.length;
        if (n >= 3 && samples[n - 1].produced === samples[n - 3].produced) break;
      }
      await reader.cancel();
      return samples;
    `,
        );
        const CHUNK = 65536;
        const last = samples[samples.length - 1];
        const twoBefore = samples[samples.length - 3];
        // The producer stopped: no growth over the last two seconds.
        expect(samples.length).toBeGreaterThanOrEqual(3);
        expect(last?.produced).toBe(twoBefore?.produced);
        for (const { produced, delivered } of samples) {
          // What this package holds: the one-chunk windows of the hops, no more.
          expect(produced - delivered).toBeLessThanOrEqual(4 * CHUNK);
        }
        // Chromium's buffer is bounded too (it took ~55 MiB when measured).
        expect((last?.delivered ?? 0) - (last?.read ?? 0)).toBeLessThan(256 * 1024 * 1024);
      });

      chromiumOnly(
        "pace: a 200 MiB page fetch is produced at the reader's pace, intact",
        async () => {
          // Bigger than Chromium's own buffer (~55 MiB), so once that is full the
          // handler can only go as fast as the page reads: 20 MiB/s here.
          const MiB = 1048576;
          const RATE = 20 * MiB;
          const page = await open("?sw=count");
          const { result, samples } = await run<{
            result: { read: number; corrupt: number; ms: number };
            samples: Array<{ t: number; read: number; produced: number; delivered: number }>;
          }>(
            page,
            `
      const delivered = () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => resolve(event.data);
          navigator.serviceWorker.controller.postMessage({ type: "delivered" }, [channel.port2]);
        });
      const pending = [];
      const response = await fetch("./page/big?mb=200");
      const result = await window.readPaced(response.body, {
        rate: ${RATE},
        onSample: (read) => {
          const t = performance.now();
          const produced = window.pageStats.producedBytes;
          pending.push(delivered().then((d) => ({ t, read, produced, delivered: d })));
        },
      });
      return { result, samples: await Promise.all(pending) };
    `,
          );
          expect(result.read).toBe(200 * MiB);
          expect(result.corrupt).toBe(0);
          // The consumer set the pace: 200 MiB at 20 MiB/s takes about 10 s.
          expect(result.ms).toBeGreaterThan(9_000);
          for (const { produced, delivered } of samples) {
            // This package holds a few chunks at most; the rest is Chromium's.
            expect(produced - delivered).toBeLessThanOrEqual(4 * 65536);
          }
          // Steady state: Chromium's buffer is full and the producer not done yet.
          const steady = samples.filter((x) => x.read > 80 * MiB && x.produced < 200 * MiB);
          expect(steady.length).toBeGreaterThanOrEqual(4);
          const leads = steady.map((x) => x.produced - x.read);
          // The lead is bounded and stays put: the producer follows the reader.
          expect(Math.max(...leads)).toBeLessThan(80 * MiB);
          expect(Math.max(...leads) - Math.min(...leads)).toBeLessThan(8 * MiB);
          const first = steady[0] as (typeof steady)[number];
          const last = steady[steady.length - 1] as (typeof steady)[number];
          const producerRate = ((last.produced - first.produced) / (last.t - first.t)) * 1000;
          expect(producerRate / RATE).toBeGreaterThan(0.75);
          expect(producerRate / RATE).toBeLessThan(1.25);
        },
      );

      it("pace: a 128 MiB stream read by a worker through the router follows its pace, a few chunks ahead", async () => {
        // page handler → ServiceWorker → worker: no browser buffer on the way,
        // so the producer is never more than the links' one-chunk windows ahead.
        const MiB = 1048576;
        const RATE = 20 * MiB;
        const page = await open();
        await run(page, `await window.attach("A");`);
        const { result, samples } = await run<{
          result: { ok: boolean; read: number; corrupt: number; ms: number };
          samples: Array<{ t: number; read: number; produced: number }>;
        }>(
          page,
          `
      const samples = [];
      const url = new URL("./page/big?mb=128", location.href).href;
      const result = await window.commandWithProgress(
        "A",
        { cmd: "pace", url, rate: ${RATE} },
        ({ read }) =>
          samples.push({ t: performance.now(), read, produced: window.pageStats.producedBytes }),
      );
      return { result, samples };
    `,
        );
        expect(result).toMatchObject({ ok: true, read: 128 * MiB, corrupt: 0 });
        expect(result.ms).toBeGreaterThan(5_800);
        const running = samples.filter((x) => x.produced < 128 * MiB);
        expect(running.length).toBeGreaterThanOrEqual(8);
        for (const { produced, read } of running) {
          // A progress message is read a moment after it was posted, so allow
          // what the reader took meanwhile on top of the windows.
          expect(produced - read).toBeLessThanOrEqual(2 * MiB);
        }
        const first = running[0] as (typeof running)[number];
        const last = running[running.length - 1] as (typeof running)[number];
        const producerRate = ((last.produced - first.produced) / (last.t - first.t)) * 1000;
        expect(producerRate / RATE).toBeGreaterThan(0.75);
        expect(producerRate / RATE).toBeLessThan(1.25);
      });

      it("cancellation: an aborted fetch reaches the handler", async () => {
        const page = await open();
        const cancelled = await run<number>(
          page,
          `
      const controller = new AbortController();
      const response = await fetch("./page/stream", { signal: controller.signal });
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      for (let i = 0; i < 50 && window.pageStats.cancelled === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return window.pageStats.cancelled;
    `,
        );
        expect(cancelled).toBe(1);
      });

      it("SSE: each event arrives as it is sent", async () => {
        const page = await open();
        const gaps = await run<number[]>(
          page,
          `
      const source = new EventSource("./page/sse");
      const times = [];
      await new Promise((resolve) => {
        source.onmessage = () => {
          times.push(performance.now());
          if (times.length === 3) { source.close(); resolve(); }
        };
      });
      return times.slice(1).map((t, i) => Math.round(t - times[i]));
    `,
        );
        for (const gap of gaps) expect(gap).toBeGreaterThan(200);
      });

      it("request bodies reach the handler whole", async () => {
        const page = await open();
        const result = await run<{ bytes: number }>(
          page,
          `
      const body = new Uint8Array(1_000_000);
      const response = await fetch("./page/echo-body", { method: "POST", body });
      return await response.json();
    `,
        );
        expect(result.bytes).toBe(1_000_000);
      });

      it("urls of keys nobody serves go to the network", async () => {
        const page = await open();
        const status = await run<number>(page, `return (await fetch("./nothing-here/x")).status;`);
        // The static server's own 404, not the worker's.
        expect(status).toBe(404);
        const text = await run<string>(
          page,
          `return await (await fetch("./nothing-here/x")).text();`,
        );
        expect(text).toBe("not found");
      });
    });

    describe("handlers in Dedicated Workers (#33)", () => {
      it("serves from a worker while the page's main thread is busy", async () => {
        const page = await open();
        await run(page, `await window.attach("A");`);
        const other = await openTab();
        // Block the first page's main thread for 2 s.
        void page
          .evaluate(`(() => { const end = Date.now() + 2000; while (Date.now() < end) {} })()`)
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 100));
        const result = await run<{ text: string; ms: number }>(
          other,
          `
      const started = performance.now();
      const text = await (await fetch("./app/who")).text();
      return { text, ms: performance.now() - started };
    `,
        );
        expect(result.text).toBe("A");
        expect(result.ms).toBeLessThan(1500);
      });

      it("spreads concurrent requests over two workers of one key", async () => {
        const page = await open();
        await run(page, `await window.attach("A"); await window.attach("B");`);
        const counts = await run<Record<string, number>>(
          page,
          `
      const names = await Promise.all(
        Array.from({ length: 100 }, () => fetch("./app/slow?ms=20").then((r) => r.text())),
      );
      const counts = {};
      for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
      return counts;
    `,
        );
        expect((counts["A:slow"] ?? 0) + (counts["B:slow"] ?? 0)).toBe(100);
        expect(counts["A:slow"]).toBeGreaterThan(20);
        expect(counts["B:slow"]).toBeGreaterThan(20);
      });

      it("a custom route picks the handler by a header", async () => {
        const page = await open("?sw=route%3Dslot");
        await run(
          page,
          `await window.attach("A", { id: "a" }); await window.attach("B", { id: "b" });`,
        );
        const names = await run<string[]>(
          page,
          `
      const who = (slot) => fetch("./app/who", { headers: { "x-slot": slot } }).then((r) => r.text());
      return [await who("b"), await who("a"), await who("b")];
    `,
        );
        expect(names).toEqual(["B", "A", "B"]);
      });

      it("drain: the request in flight finishes, a later one waits for the next owner", async () => {
        const page = await open();
        await run(page, `await window.attach("A", { id: "slot" });`);
        const result = await run<string[]>(
          page,
          `
      const inflight = fetch("./app/slow?ms=1500").then((r) => r.text());
      await new Promise((r) => setTimeout(r, 200));
      const drained = window.workers.A.link.drain({ ms: 5000 });
      await new Promise((r) => setTimeout(r, 100));
      const later = fetch("./app/who").then((r) => r.text());
      await new Promise((r) => setTimeout(r, 300));
      await window.attach("B", { id: "slot" });
      return [await inflight, await later, String(await drained)];
    `,
        );
        expect(result).toEqual(["A:slow", "B", "undefined"]);
      });

      it("a late drain naming the previous owner leaves the current one alone", async () => {
        const page = await open();
        const result = await run<string>(
          page,
          `
      await window.attach("A", { id: "slot" });
      const old = window.workers.A.link;
      await window.attach("B", { id: "slot" });
      await old.drain({ ms: 100 });
      return await (await fetch("./app/who")).text();
    `,
        );
        expect(result).toBe("B");
      });

      it("after a drain, a request waits for attachWorker", async () => {
        const page = await open();
        const result = await run<string>(
          page,
          `
      await window.attach("A", { id: "slot" });
      await window.workers.A.link.drain({ ms: 100 });
      const response = fetch("./app/who").then((r) => r.text());
      await new Promise((r) => setTimeout(r, 300));
      await window.attach("B", { id: "slot" });
      return await response;
    `,
        );
        expect(result).toBe("B");
      });

      it("after a drain, a request gets 503 when nobody attaches in time", async () => {
        const page = await open("?sw=attach%3D500");
        const status = await run<number>(
          page,
          `
      await window.attach("A", { id: "slot" });
      await window.workers.A.link.drain({ ms: 100 });
      return (await fetch("./app/who")).status;
    `,
        );
        expect(status).toBe(503);
      });

      it("a key whose handler is gone answers 404 at once, not the network", async () => {
        const page = await open();
        await run(page, `await window.attach("A");`);
        const result = await run<{ status: number; ms: number }>(
          page,
          `
      await window.workers.A.link.detach();
      // The first request after the loss asks the pages for links (one round);
      // the next one answers at once.
      await fetch("./app/who");
      const started = performance.now();
      const status = (await fetch("./app/who")).status;
      return { status, ms: performance.now() - started };
    `,
        );
        expect(result.status).toBe(404);
        expect(result.ms).toBeLessThan(500);
      });

      it("a worker fetches another handler through the router", async () => {
        const page = await open();
        await run(page, `await window.attach("A");`);
        const text = await run<string>(
          page,
          `return await (await fetch("./app/up?url=" + encodeURIComponent(new URL("./page/who", location.href)))).text();`,
        );
        expect(text).toBe("A via up: page");
      });
    });

    describe("ServiceWorker restarts and handler deaths (#34)", () => {
      chromiumOnly(
        "restart: the next request is served, from a worker and from the page",
        async () => {
          const page = await open();
          await run(page, `await window.attach("A");`);
          await stopServiceWorkers(page);
          const texts = await run<string[]>(
            page,
            `return [await (await fetch("./app/who")).text(), await (await fetch("./page/who")).text()];`,
          );
          expect(texts).toEqual(["A", "page"]);
        },
      );

      chromiumOnly("restart: handlers in two tabs are linked again", async () => {
        const page = await open();
        await run(page, `await window.attach("A", { id: "a" });`);
        const second = await openTab();
        await run(second, `await window.attach("B", { id: "b" });`);
        await stopServiceWorkers(page);
        const names = await run<string[]>(
          page,
          `
      // The first request after the restart waits for the round of re-links.
      await fetch("./app/who");
      const names = await Promise.all(
        Array.from({ length: 20 }, () => fetch("./app/slow?ms=50").then((r) => r.text())),
      );
      return [...new Set(names)].sort();
    `,
        );
        expect(names).toEqual(["A:slow", "B:slow"]);
      });

      chromiumOnly("restart: a replaced worker does not take its slot back", async () => {
        const page = await open();
        await run(
          page,
          `await window.attach("A", { id: "slot" }); await window.attach("B", { id: "slot" });`,
        );
        await stopServiceWorkers(page);
        const names = await run<string[]>(
          page,
          `
      const names = [];
      for (let i = 0; i < 5; i++) names.push(await (await fetch("./app/who")).text());
      return names;
    `,
        );
        expect(names).toEqual(["B", "B", "B", "B", "B"]);
      });

      chromiumOnly("restart: a terminated worker is not attached again", async () => {
        const page = await open();
        await run(
          page,
          `await window.attach("A", { id: "a" }); await window.attach("B", { id: "b" });`,
        );
        await run(page, `window.workers.A.worker.terminate();`);
        await stopServiceWorkers(page);
        const statuses = await run<string[]>(
          page,
          `
      const out = [];
      for (let i = 0; i < 10; i++) {
        const response = await fetch("./app/who");
        out.push(response.status + ":" + (await response.text()));
      }
      return [...new Set(out)];
    `,
        );
        expect(statuses).toEqual(["200:B"]);
      });

      chromiumOnly(
        "wake: a call through the router after a stop completes, with no fetch event",
        async () => {
          const page = await open();
          await run(page, `await window.attach("A");`);
          const url = `${origin}${BASE}page/who`;
          // The worker's first call links its `up` port; then the ServiceWorker stops.
          expect(
            await run(page, `return await window.command("A", { cmd: "up", url: "${url}" });`),
          ).toMatchObject({
            ok: true,
            text: "page",
          });
          await stopServiceWorkers(page);
          await new Promise((r) => setTimeout(r, 200));
          // Its router lock is granted, so its link is dropped; the next call asks
          // the page to link it again, and the page's attach wakes the worker.
          expect(
            await run(page, `return await window.command("A", { cmd: "up", url: "${url}" });`),
          ).toMatchObject({
            ok: true,
            text: "page",
          });
        },
      );

      chromiumOnly(
        "in flight: a call over up fails instead of hanging when the ServiceWorker stops",
        async () => {
          const page = await open();
          await run(page, `await window.attach("A");`);
          const url = `${origin}${BASE}page/slow?ms=3000`;
          const pending = run<{ ok: boolean; text: string }>(
            page,
            `return await window.command("A", { cmd: "up", url: "${url}" });`,
          );
          await new Promise((r) => setTimeout(r, 500));
          const started = Date.now();
          await stopServiceWorkers(page);
          const result = await pending;
          expect(result.ok).toBe(false);
          expect(result.text).toMatch(
            /ServiceWorker was lost while this call was in flight; it may or may not have been applied/,
          );
          expect(Date.now() - started).toBeLessThan(2000);
        },
      );

      it("owner death: closing the serving tab fails its request at once", async () => {
        const page = await open();
        const serving = await openTab();
        await run(serving, `await window.attach("S");`);
        const started = Date.now();
        const pending = run<{ status: number; text: string }>(
          page,
          `
      try {
        const response = await fetch("./app/slow?ms=10000");
        return { status: response.status, text: await response.text() };
      } catch (error) {
        return { status: 0, text: error.message };
      }
    `,
        );
        await new Promise((r) => setTimeout(r, 500));
        await serving.close();
        const result = await pending;
        expect(Date.now() - started).toBeLessThan(5000);
        expect(result.status).toBe(502);
        expect(result.text).toMatch(/may or may not have been applied/);
      });
    });

    describe("WebSockets (#35, #36)", () => {
      it("through the ServiceWorker: text, binary and a subprotocol, from page to worker", async () => {
        const page = await open();
        await run(page, `await window.attach("A");`);
        const result = await run<{ protocol: string; text: string; bytes: number[] }>(
          page,
          `
      const ws = new window.adapter.WebSocket(new URL("./app/chat", location.href), ["v1"]);
      ws.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      const next = () => new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); });
      ws.send("hi");
      const text = await next();
      ws.send(new Uint8Array([1, 2, 3]));
      const bytes = [...new Uint8Array(await next())];
      ws.close();
      return { protocol: ws.protocol, text, bytes };
    `,
        );
        expect(result).toEqual({ protocol: "v1", text: "A:hi", bytes: [1, 2, 3] });
      });

      it("a refused upgrade gives error, then close with 1006", async () => {
        const page = await open();
        await run(page, `await window.attach("A");`);
        const events = await run<string[]>(
          page,
          `
      const ws = new window.adapter.WebSocket(new URL("./app/ws-refuse", location.href));
      const events = [];
      ws.onerror = () => events.push("error");
      await new Promise((resolve) => { ws.onclose = (e) => { events.push("close:" + e.code); resolve(); }; });
      return events;
    `,
        );
        expect(events).toEqual(["error", "close:1006"]);
      });

      it("a page handler's socket needs no ServiceWorker", async () => {
        const page = await open();
        const text = await run<string>(
          page,
          `
      const ws = new window.adapter.WebSocket(new URL("./page/chat", location.href));
      await new Promise((resolve) => { ws.onopen = resolve; });
      ws.send("x");
      const reply = await new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); });
      ws.close();
      return reply;
    `,
        );
        expect(text).toBe("page:x");
      });

      chromiumOnly(
        "restart: an open socket keeps working, the ServiceWorker is not on its path",
        async () => {
          const page = await open();
          await run(page, `await window.attach("A");`);
          await run(
            page,
            `
      const ws = new window.adapter.WebSocket(new URL("./app/chat", location.href));
      await new Promise((resolve) => { ws.onopen = resolve; });
      window.socket = ws;
    `,
          );
          await stopServiceWorkers(page);
          const reply = await run<string>(
            page,
            `
      window.socket.send("after");
      return await new Promise((resolve) => { window.socket.onmessage = (e) => resolve(e.data); });
    `,
          );
          expect(reply).toBe("A:after");
        },
      );

      it("worker to worker: a handler opens a socket to another handler through the router", async () => {
        const page = await open();
        await run(page, `await window.attach("A");`);
        const text = await run<string>(
          page,
          `return await (await fetch("./app/ws-up?url=" + encodeURIComponent(new URL("./page/chat", location.href)))).text();`,
        );
        expect(text).toBe("A got page:hello");
      });

      it("from a page with no adapter: serviceWorkerWebSocketClass", async () => {
        const page = await open();
        await run(page, `await window.attach("A");`);
        const second = await openTab();
        const text = await run<string>(
          second,
          `
      const WS = window.lib.serviceWorkerWebSocketClass();
      const ws = new WS(new URL("./app/chat", location.href));
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      ws.send("y");
      const reply = await new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); });
      ws.close();
      return reply;
    `,
        );
        expect(text).toBe("A:y");
      });

      it("owner loss: the socket closes with 1006 when the handler's tab dies", async () => {
        const page = await open();
        const serving = await openTab();
        await run(serving, `await window.attach("S");`);
        await run(
          page,
          `
      const WS = window.lib.createWebSocketClass(window.adapter.connectWebSocket, { heartbeatMs: 200 });
      const ws = new WS(new URL("./app/chat", location.href));
      await new Promise((resolve) => { ws.onopen = resolve; });
      window.socketClosed = new Promise((resolve) => { ws.onclose = (e) => resolve(e.code); });
    `,
        );
        await serving.close();
        const code = await run<number>(page, `return await window.socketClosed;`);
        expect(code).toBe(1006);
      });
    });
  });
}
