import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  duplexOverPort,
  multiplexPort,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function waitFor(label: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const c of open.splice(0)) c();
});

const echo: Duplex = async function* echo(input) {
  for await (const chunk of input) yield chunk;
};

describe("duplexOverPort — a peer that ignores the protocol (spec D15)", () => {
  it("refuses a second unconfirmed chunk and closes that port", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    // A handler that never drains its input, so the first chunk stays
    // unconfirmed for as long as the test needs.
    const off = serveDuplexOverPort(channel.port2, async function* stalled() {
      await new Promise((r) => setTimeout(r, 5000));
    });
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });

    const replies: Array<{ type: string; error?: { message?: string } }> = [];
    channel.port1.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as
        | { type?: string; error?: { message?: string } }
        | undefined;
      if (data?.type === "response:error" || data?.type === "response:result") {
        replies.push(data as { type: string; error?: { message?: string } });
      }
    });

    // Hand-rolled hostile sender: two chunk requests, no waiting.
    channel.port1.postMessage({
      type: "request",
      channelName: "in",
      callId: "hostile-1",
      params: { done: false, value: enc.encode("first") },
    });
    channel.port1.postMessage({
      type: "request",
      channelName: "in",
      callId: "hostile-2",
      params: { done: false, value: enc.encode("second") },
    });

    await waitFor("a refusal came back", () => replies.some((r) => r.type === "response:error"));
    const refusal = replies.find((r) => r.type === "response:error");
    expect(refusal?.error?.message).toMatch(/second unconfirmed chunk/);
  }, 20_000);

  it("a cooperative sender is never refused, however many chunks it sends", async () => {
    // The floor (G12): the rule above must not be satisfiable by refusing
    // everything. 200 chunks in strict sequence must all get through.
    const size = 200 * 512;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = i & 0xff;
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = serveDuplexOverPort(channel.port2, echo, { maxMessageSize: 512 });
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });
    const out = await collectBytes(duplexOverPort(channel.port1, { maxMessageSize: 512 })([body]));
    expect(out.byteLength).toBe(size);
    expect(out[size - 1]).toBe((size - 1) & 0xff);
  }, 30_000);

  it("the penalty is scoped to the offending port; the mux still serves", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const serverMux = multiplexPort(channel.port2, {
      codec: structuredCodec,
      side: "responder",
      onPort: (p, meta) => {
        if ((meta as { kind?: string } | undefined)?.kind === "stalled") {
          serveDuplexOverPort(p, async function* () {
            await new Promise((r) => setTimeout(r, 5000));
          });
        } else {
          serveDuplexOverPort(p, echo);
        }
      },
    });
    const clientMux = multiplexPort(channel.port1, {
      codec: structuredCodec,
      side: "initiator",
    });
    open.push(() => {
      void clientMux.close();
      void serverMux.close();
    });

    const hostilePort = await clientMux.openPort({ kind: "stalled" });
    hostilePort.postMessage({
      type: "request",
      channelName: "in",
      callId: "h1",
      params: { done: false, value: enc.encode("a") },
    });
    hostilePort.postMessage({
      type: "request",
      channelName: "in",
      callId: "h2",
      params: { done: false, value: enc.encode("b") },
    });
    await new Promise((r) => setTimeout(r, 60));

    const goodPort = await clientMux.openPort({ kind: "stream" });
    const out = await collectBytes(duplexOverPort(goodPort)([enc.encode("unaffected")]));
    expect(dec.decode(out)).toBe("unaffected");
  }, 20_000);

  it("garbage on a stream port is ignored and the stream still works", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = serveDuplexOverPort(channel.port2, echo);
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });
    for (const junk of [
      undefined,
      null,
      42,
      "a string",
      { type: "request" },
      { type: "request", channelName: "in" },
      { type: "nonsense", channelName: "in", callId: "x", params: {} },
      { type: "response:result", channelName: "in", callId: "never-sent", result: 1 },
    ]) {
      channel.port1.postMessage(junk);
    }
    const out = await collectBytes(duplexOverPort(channel.port1)([enc.encode("still-works")]));
    expect(dec.decode(out)).toBe("still-works");
  }, 20_000);
});
