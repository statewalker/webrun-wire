import { describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import type { WebSocketLike } from "../src/websocket-like.js";

/** Echo server: every inbound frame goes straight back. */
async function echoServer(): Promise<{ url: string; close(): Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => {
    ws.binaryType = "nodebuffer";
    ws.on("message", (data: Buffer) => ws.send(data));
  });
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}

async function openSocket(url: string): Promise<WebSocketLike> {
  const ws = new NodeWebSocket(url) as unknown as WebSocketLike;
  (ws as unknown as { binaryType: string }).binaryType = "nodebuffer";
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error before open")));
  });
  return ws;
}

/** Round-trip `count` frames of `size` bytes, awaiting each before sending the next. */
async function timeRoundTrips(
  send: (bytes: Uint8Array) => void,
  onMessage: (cb: (bytes: Uint8Array) => void) => void,
  count: number,
  size: number,
): Promise<number> {
  const payload = new Uint8Array(size).fill(7);
  let resolveOne: (() => void) | null = null;
  onMessage(() => {
    const r = resolveOne;
    resolveOne = null;
    r?.();
  });
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const done = new Promise<void>((r) => {
      resolveOne = r;
    });
    send(payload);
    await done;
  }
  return performance.now() - started;
}

describe("cost of bridging a WebSocket to a real MessagePort", () => {
  it("reports direct vs bridged round-trip cost at three sizes", async () => {
    const server = await echoServer();
    const results: Array<{ size: number; direct: number; bridged: number; ratio: number }> = [];
    try {
      for (const size of [64, 4096, 64 * 1024]) {
        const count = size > 8192 ? 200 : 1000;

        // (a) Direct: the transport's own frames, no MessagePort anywhere.
        const wsDirect = await openSocket(server.url);
        const direct = await timeRoundTrips(
          (bytes) => (wsDirect as unknown as { send(d: Uint8Array): void }).send(bytes),
          (cb) =>
            wsDirect.addEventListener("message", (ev) => {
              const d = (ev as MessageEvent).data as ArrayBufferView | ArrayBuffer;
              cb(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer));
            }),
          count,
          size,
        );
        (wsDirect as unknown as { close(): void }).close();

        // (b) Bridged: WebSocket <-> pump <-> MessageChannel, the shape a port
        // factory must expose, and the caller talks only to `port`.
        const wsBridged = await openSocket(server.url);
        const channel = new MessageChannel();
        channel.port1.start();
        channel.port2.start();
        // pump: transport -> port2 -> (caller holds port1)
        wsBridged.addEventListener("message", (ev) => {
          const d = (ev as MessageEvent).data as ArrayBufferView | ArrayBuffer;
          const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength);
          channel.port2.postMessage(bytes.slice());
        });
        // pump: port2 <- port1 -> transport
        channel.port2.addEventListener("message", (ev) => {
          (wsBridged as unknown as { send(d: Uint8Array): void }).send((ev as MessageEvent).data as Uint8Array);
        });
        const bridged = await timeRoundTrips(
          (bytes) => channel.port1.postMessage(bytes),
          (cb) => channel.port1.addEventListener("message", (ev) => cb((ev as MessageEvent).data as Uint8Array)),
          count,
          size,
        );
        channel.port1.close();
        channel.port2.close();
        (wsBridged as unknown as { close(): void }).close();

        results.push({ size, direct, bridged, ratio: bridged / direct });
      }
    } finally {
      await server.close();
    }

    for (const r of results) {
      console.log(
        `size=${String(r.size).padStart(6)}B  direct=${r.direct.toFixed(1)}ms  bridged=${r.bridged.toFixed(1)}ms  ratio=${r.ratio.toFixed(2)}x`,
      );
    }

    // Deliberately loose. This records a number; it does not gate a threshold,
    // because a timing threshold on shared CI hardware is a flake generator.
    // The floor is that both paths actually completed every round trip.
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.direct).toBeGreaterThan(0);
      expect(r.bridged).toBeGreaterThan(0);
    }
  }, 120_000);
});
