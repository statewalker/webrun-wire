/**
 * The relay over webrun-rpc + webrun-http-streams (#32), WebSockets through
 * it (#36), and its registration rules (#13), in Chromium against the BUILT
 * bundles.
 *
 * The host page runs on `localhost`, the relay on `127.0.0.1`: two origins,
 * as in a real deployment, so everything crosses the relay iframe.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = "/tests/fixtures/browser/relay-links/";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

let server: Server;
let hostOrigin: string;
let relayOrigin: string;
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
  const port = (server.address() as AddressInfo).port;
  hostOrigin = `http://localhost:${port}`;
  relayOrigin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

async function open(): Promise<Page> {
  await context?.close();
  context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("[page]", error));
  await page.goto(`${hostOrigin}${FIXTURE}index.html?relay=${encodeURIComponent(relayOrigin)}`);
  await page.waitForFunction(() => "ready" in window);
  await page.evaluate("window.ready");
  return page;
}

async function run<T = unknown>(target: Page | Frame, body: string): Promise<T> {
  return (await target.evaluate(`(async () => { ${body} })()`)) as T;
}

/** The relay iframe, once its worker controls it: only then do its fetches reach the worker. */
async function relayFrame(page: Page): Promise<Frame> {
  const frame = page.frames().find((f) => f.url().startsWith(relayOrigin));
  if (!frame) throw new Error("no relay frame");
  await run(
    frame,
    `
    const lib = await import("/dist/index.js");
    const registration = await navigator.serviceWorker.getRegistration();
    await lib.awaitServiceWorkerControl(registration, { timeout: 5000 });
  `,
  );
  return frame;
}

describe("relay", () => {
  it("callHttpService streams with backpressure, and cancels the producer", async () => {
    const page = await open();
    const result = await run<{ produced: number; cancelled: number }>(
      page,
      `
      const response = await window.lib.callHttpService(new Request(window.base + "stream"), {
        key: "K",
        port: window.connection.port,
      });
      const reader = response.body.getReader();
      for (let i = 0; i < 40; i++) {
        await reader.read();
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 200));
      const produced = window.stats.produced;
      await reader.cancel();
      for (let i = 0; i < 50 && window.stats.cancelled === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return { produced, cancelled: window.stats.cancelled };
    `,
    );
    expect(result.produced - 40).toBeLessThanOrEqual(6);
    expect(result.cancelled).toBe(1);
  });

  it("a fetch on the relay origin reaches the service over the new transport", async () => {
    const page = await open();
    const text = await run<string>(
      await relayFrame(page),
      `return await (await fetch("${FIXTURE}svc/who")).text();`,
    );
    expect(text).toBe("relay");
  });

  it("a page on another origin opens a socket to the service", async () => {
    const page = await open();
    const result = await run<{ protocol: string; text: string; bytes: number[] }>(
      page,
      `
      const WS = window.lib.relayWebSocketClass({ key: "K", port: window.connection.port });
      const ws = new WS(window.base + "chat", ["v1"]);
      ws.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      const next = () => new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); });
      ws.send("hi");
      const text = await next();
      ws.send(new Uint8Array([7, 8]));
      const bytes = [...new Uint8Array(await next())];
      ws.close();
      return { protocol: ws.protocol, text, bytes };
    `,
    );
    expect(result).toEqual({ protocol: "v1", text: "relay:hi", bytes: [7, 8] });
  });

  it("a refused socket fails with error and 1006", async () => {
    const page = await open();
    const events = await run<string[]>(
      page,
      `
      const WS = window.lib.relayWebSocketClass({ key: "K", port: window.connection.port });
      const ws = new WS(window.base + "ws-refuse");
      const events = [];
      ws.onerror = () => events.push("error");
      await new Promise((resolve) => { ws.onclose = (e) => { events.push("close:" + e.code); resolve(); }; });
      return events;
    `,
    );
    expect(events).toEqual(["error", "close:1006"]);
  });

  it("content on the relay origin opens a socket through the relay worker", async () => {
    const page = await open();
    const text = await run<string>(
      await relayFrame(page),
      `
      const lib = await import("/dist/index.js");
      const WS = lib.serviceWorkerWebSocketClass();
      const ws = new WS("${FIXTURE}svc/chat");
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      ws.send("from-relay");
      const reply = await new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); });
      ws.close();
      return reply;
    `,
    );
    expect(text).toBe("relay:from-relay");
  });
});

describe("relay registration (#13)", () => {
  it("canRegister sees the path a key asks for", async () => {
    const page = await open();
    const result = await run<string>(
      page,
      `
      try {
        await window.lib.initHttpService(async () => new Response("x"), {
          key: "evil",
          path: "${FIXTURE}index.html",
          port: window.connection.port,
        });
        return "registered";
      } catch (error) {
        return error.message;
      }
    `,
    );
    expect(result).toMatch(/may not register "evil" at/);
  });

  it("UNREGISTER from another client is refused", async () => {
    const page = await open();
    const other = await (context as BrowserContext).newPage();
    await other.goto(`${relayOrigin}${FIXTURE}relay.html`);
    const result = await run<string>(
      other,
      `
      const lib = await import("/dist/index.js");
      const channel = new MessageChannel();
      window.postMessage({ type: "CONNECT" }, "*", [channel.port1]);
      try {
        await lib.callChannel(channel.port2, "UNREGISTER", { key: "K" });
        return "unregistered";
      } catch (error) {
        return error.message;
      }
    `,
    );
    expect(result).toMatch(/served by another client/);
    // The service still answers.
    const text = await run<string>(
      await relayFrame(page),
      `return await (await fetch("${FIXTURE}svc/who")).text();`,
    );
    expect(text).toBe("relay");
  });

  it("stop() resolves once the relay has dropped the service", async () => {
    const page = await open();
    const frame = await relayFrame(page);
    expect(await run(frame, `return await (await fetch("${FIXTURE}svc/who")).text();`)).toBe(
      "relay",
    );
    await run(page, `await window.stop();`);
    // The mount is gone the moment stop() resolves: the url is the network's again.
    const text = await run<string>(
      frame,
      `return await (await fetch("${FIXTURE}svc/who")).text();`,
    );
    expect(text).toBe("not found");
  });
});
