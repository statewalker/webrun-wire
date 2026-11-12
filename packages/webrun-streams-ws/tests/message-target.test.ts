import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe } from "@statewalker/webrun-rpc";
import { collectBytes } from "@statewalker/webrun-streams";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { messageTargetOverWebSocket, openWebSocket } from "../src/message-target.js";
import type { WebSocketLike } from "../src/websocket-like.js";
import { makeWsPortPair } from "./make-ws-port-pair.js";

describeDuplexAdapter("webrun-streams-ws over multiplexPort", makeWsPortPair);

const NodeCtor = NodeWebSocket as unknown as new (u: string, p?: string | string[]) => WebSocketLike;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A server whose accepted sockets are handed to the test. */
async function server(): Promise<{ url: string; next(): Promise<NodeWebSocket> }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const waiting: Array<(ws: NodeWebSocket) => void> = [];
  const accepted: NodeWebSocket[] = [];
  wss.on("connection", (ws) => {
    ws.binaryType = "nodebuffer";
    const w = waiting.shift();
    if (w) w(ws);
    else accepted.push(ws);
  });
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  );
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    next: () =>
      new Promise((r) => {
        const ws = accepted.shift();
        if (ws) r(ws);
        else waiting.push(r);
      }),
  };
}

async function pipePair() {
  const s = await server();
  const clientWs = await openWebSocket({ url: s.url, WebSocketCtor: NodeCtor });
  const serverWs = await s.next();
  const a = messageTargetOverWebSocket(clientWs);
  const b = messageTargetOverWebSocket(serverWs as unknown as WebSocketLike);
  cleanups.push(() => a.target.close());
  return { a, b, clientWs, serverWs };
}

const nextMessage = (t: { addEventListener: (k: "message", l: (e: MessageEvent) => void) => void }) =>
  new Promise<unknown>((r) => t.addEventListener("message", (e) => r(e.data)));

describe("messageTargetOverWebSocket", () => {
  it("carries bytes both ways, one message per post, as Uint8Array", async () => {
    const { a, b } = await pipePair();
    const got = nextMessage(b.target);
    a.target.postMessage(new Uint8Array([1, 2, 3]));
    const data = await got;
    expect(data).toBeInstanceOf(Uint8Array);
    expect([...(data as Uint8Array)]).toEqual([1, 2, 3]);
    const back = nextMessage(a.target);
    b.target.postMessage(new Uint8Array([9]).buffer);
    expect([...((await back) as Uint8Array)]).toEqual([9]);
  });

  it("refuses anything but bytes: a codec breaking its contract is not papered over", async () => {
    const { a } = await pipePair();
    expect(() => a.target.postMessage({ not: "bytes" })).toThrow(TypeError);
    expect(() => a.target.postMessage("text")).toThrow(TypeError);
  });

  it("aborts its signal when the peer goes away, and posting after that is a no-op", async () => {
    const { a, serverWs } = await pipePair();
    expect(a.signal.aborted).toBe(false);
    serverWs.terminate();
    await new Promise<void>((r) => a.signal.addEventListener("abort", () => r(), { once: true }));
    expect(a.signal.reason).toBeInstanceOf(Error);
    expect(() => a.target.postMessage(new Uint8Array([1]))).not.toThrow();
  });

  it("close() closes the socket and aborts the signal on both ends", async () => {
    const { a, b } = await pipePair();
    await a.target.close();
    expect(a.signal.aborted).toBe(true);
    await new Promise<void>((r) =>
      b.signal.aborted ? r() : b.signal.addEventListener("abort", () => r(), { once: true }),
    );
  });

  it("reports bufferedAmount, and whenDrained waits for the socket to write it out", async () => {
    const { a, b } = await pipePair();
    let received = 0;
    b.target.addEventListener("message", (e) => {
      received += (e.data as Uint8Array).byteLength;
    });
    const big = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < 4; i++) a.target.postMessage(big);
    expect(a.target.bufferedAmount).toBeGreaterThan(0);
    await a.target.whenDrained();
    expect(a.target.bufferedAmount).toBe(0);
    await expect.poll(() => received, { timeout: 10_000 }).toBe(4 * big.byteLength);
  });

  it("a dead peer fails the calls in flight over the multiplexer, instead of parking them", async () => {
    const s = await server();
    const ws = await openWebSocket({ url: s.url, WebSocketCtor: NodeCtor });
    const serverWs = await s.next();
    const { target, signal } = messageTargetOverWebSocket(ws);
    const { call, close } = await connect({
      mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal }),
    });
    cleanups.push(close);
    const pending = collectBytes(call((async function* () {})()));
    serverWs.terminate();
    await expect(pending).rejects.toBeDefined();
  });
});

describe("openWebSocket", () => {
  it("resolves with an open socket", async () => {
    const s = await server();
    const ws = await openWebSocket({ url: s.url, WebSocketCtor: NodeCtor });
    cleanups.push(() => ws.close());
    expect(ws.readyState).toBe(1);
  });

  it("rejects when the connection is refused", async () => {
    await expect(
      openWebSocket({ url: "ws://127.0.0.1:1", WebSocketCtor: NodeCtor }),
    ).rejects.toThrow();
  });
});
