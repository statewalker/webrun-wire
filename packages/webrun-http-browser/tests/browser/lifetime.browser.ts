/**
 * How long the ServiceWorker lives, in a Chromium that may stop it (#34).
 *
 * Playwright keeps every ServiceWorker running, so these tests drive their own
 * Chromium over raw CDP (`raw-chromium.ts`), attached to pages only. There the
 * browser stops an idle ServiceWorker after about 30 s, as it does for users.
 *
 * - The control: with the worker's keep-alive off, a 45 s call through the
 *   router fails when the ServiceWorker is stopped, with the loss error, not a
 *   hang. This proves the stop really happens here.
 * - With the keep-alive (every 20 s, the default), the same call completes.
 * - A response streaming through the ServiceWorker keeps it alive by itself:
 *   a 60 s event stream arrives whole, each event on time.
 *
 * Chromium only, and slow (about a minute): the three run concurrently, each
 * in its own browser.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRawChromium, type RawPage } from "./raw-chromium.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const PAGE = "/tests/fixtures/browser/links/index.html";

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

/** Runs `scenario` on the fixture page of a fresh raw Chromium. */
async function withPage<T>(scenario: (page: RawPage) => Promise<T>): Promise<T> {
  const browser = await launchRawChromium();
  try {
    const page = await browser.newPage(`${origin}${PAGE}`);
    await page.evaluate(
      `(async () => { while (!window.ready) await new Promise((r) => setTimeout(r, 50)); return await window.ready; })()`,
    );
    return await scenario(page);
  } finally {
    await browser.close();
  }
}

/** A 45 s call from a worker, through the router, to the page's handler. */
async function longCallThroughRouter(page: RawPage, query: string) {
  await page.evaluate(`window.attach("A", {}, "${query}")`);
  const started = Date.now();
  const result = await page.evaluate<{ ok: boolean; text: string }>(
    `window.command("A", { cmd: "up", url: new URL("./page/slow?ms=45000", location.href).href })`,
  );
  return { ...result, ms: Date.now() - started };
}

describe.concurrent("ServiceWorker lifetime (raw Chromium)", () => {
  it("control: without the keep-alive, a 45 s call fails when the ServiceWorker idles out", async () => {
    const result = await withPage((page) => longCallThroughRouter(page, "&keepalive=1000000"));
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(
      /ServiceWorker was lost while this call was in flight; it may or may not have been applied/,
    );
    // Chromium's idle timeout is about 30 s; the call fails then, not at 45 s.
    expect(result.ms).toBeLessThan(44_000);
  }, 120_000);

  it("keep-alive: a 45 s call through the router completes", async () => {
    const result = await withPage((page) => longCallThroughRouter(page, ""));
    expect(result).toMatchObject({ ok: true, text: "page:slow" });
    expect(result.ms).toBeGreaterThanOrEqual(45_000);
  }, 120_000);

  it("a 60 s response stream keeps the ServiceWorker alive", async () => {
    const result = await withPage((page) =>
      page.evaluate<{ ok: boolean; error?: string; times: number[] }>(`(async () => {
        const started = performance.now();
        const times = [];
        try {
          const reader = (await fetch("./page/events?n=13&ms=5000")).body.getReader();
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
            times.push(Math.round(performance.now() - started));
          }
          return { ok: true, times };
        } catch (error) {
          return { ok: false, error: error.message, times };
        }
      })()`),
    );
    expect(result.ok).toBe(true);
    expect(result.times).toHaveLength(13);
    // Each event arrives about when it is sent, 5 s apart, past the 30 s mark.
    for (const [i, t] of result.times.entries()) {
      expect(Math.abs(t - i * 5000)).toBeLessThan(2000);
    }
  }, 120_000);
});
