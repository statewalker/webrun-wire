// Proves the only transport this package exists for: page -> ServiceWorker -> EventSource.
// Every other test in this package uses a fake EventSource and an in-process Response; this one
// drives a real Chromium tab, a real ServiceWorker (`@statewalker/webrun-http-browser`'s
// `sw-worker.js`), and a real `text/event-stream` fetch through it.
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./server.js";

let browser: Browser;
let page: Page;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ stop } = await startFixtureServer(8791));
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto("http://localhost:8791/", { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const controlledOnFirstLoad = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlledOnFirstLoad) {
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(1500);
  }
  console.log(`[sse-browser] controlled on first load: ${controlledOnFirstLoad}`);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stop?.();
});

const snapshot = () =>
  page.evaluate(() => ({
    received: (window as any).__received.length,
    published: (window as any).__published,
    gaps: (window as any).__gaps,
  }));

describe("SSE through a real ServiceWorker", () => {
  it("delivers every event and survives past the 30s SW idle window", async () => {
    await page.waitForTimeout(35_000);
    const mid = await snapshot();
    console.log(
      `[sse-browser] t=~35s received=${mid.received} published=${mid.published} gaps=${mid.gaps}`,
    );
    expect(mid.received).toBe(mid.published);
    expect(mid.received).toBeGreaterThan(30);

    await page.waitForTimeout(15_000);
    const end = await snapshot();
    console.log(
      `[sse-browser] t=~50s received=${end.received} published=${end.published} gaps=${end.gaps}`,
    );
    expect(end.received).toBeGreaterThan(mid.received); // still alive after idle
    expect(end.received).toBe(end.published); // nothing dropped
    expect(end.gaps).toBe(0);
  }, 90_000);

  // (5) two subscribers, through the real transport
  it("delivers to two concurrent subscribers on one topic", async () => {
    const counts = await page.evaluate(async () => {
      const w = window as any;
      const a: unknown[] = [];
      const b: unknown[] = [];
      const offA = w.__client.subscribe("multi", (d: unknown) => a.push(d));
      const offB = w.__client.subscribe("multi", (d: unknown) => b.push(d));
      await new Promise((r) => setTimeout(r, 300));
      w.__ps.publish("multi", { n: 1 }, "rebuilt");
      await new Promise((r) => setTimeout(r, 500));
      offA();
      offB();
      return { a: a.length, b: b.length };
    });
    console.log(`[sse-browser] concurrent subscribers: a=${counts.a} b=${counts.b}`);
    expect(counts).toEqual({ a: 1, b: 1 });
  }, 30_000);
});
