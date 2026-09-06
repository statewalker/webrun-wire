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
    const hostileReplies: Array<{ type: string; error?: { message?: string } }> = [];
    hostilePort.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as
        | { type?: string; error?: { message?: string } }
        | undefined;
      if (data?.type === "response:error") {
        hostileReplies.push(data as { type: string; error?: { message?: string } });
      }
    });
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

    // The scoping claim has two halves: the offender actually gets refused
    // (checked first — this is the half a mux-isolation-only test misses,
    // since it never inspects the hostile port's own traffic), and everyone
    // else on the mux is unaffected by it (checked second).
    await waitFor("a refusal arrives on the hostile port", () => hostileReplies.length > 0);
    const refusal = hostileReplies[0];
    expect(refusal.error?.message).toMatch(/second unconfirmed chunk/);

    const goodPort = await clientMux.openPort({ kind: "stream" });
    const out = await collectBytes(duplexOverPort(goodPort)([enc.encode("unaffected")]));
    expect(dec.decode(out)).toBe("unaffected");
  }, 20_000);

  it("poison arriving before the local consumer's first pull fails the stream, not hangs it", async () => {
    // Consequence (a) of the Critical fix: if the second, offending chunk is
    // processed before the handler has ever called `.next()` on its input
    // (any handler that awaits something first), `deliver` is still
    // undefined and a hand-rolled `void deliver?.(...)` would be a silent
    // no-op. Routing the poison through `controller.abort()` is what makes
    // `recieveIterator`'s installer replay the error once the handler does
    // start pulling, instead of leaving it to wait forever.
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const seen: Uint8Array[] = [];
    let caught: unknown;
    const off = serveDuplexOverPort(channel.port2, async function* lateDrain(input) {
      // Awaits something unrelated to `input` before ever touching it, so
      // both hostile chunks land while `deliver` is still unassigned.
      await new Promise((r) => setTimeout(r, 100));
      try {
        for await (const chunk of input) seen.push(chunk);
      } catch (err) {
        caught = err;
        throw err;
      }
    });
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });

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

    await waitFor(
      "the handler's for-await throws instead of hanging",
      () => caught !== undefined,
      3000,
    );
    expect((caught as Error)?.message).toMatch(/second unconfirmed chunk/);
  }, 10_000);

  it("a poisoned stream's outbound pump settles and the handler's finally runs", async () => {
    // Consequence (b) of the Critical fix: without routing the poison through
    // `controller.abort()`, `port.close()` makes any in-flight outbound
    // `callPort` call (run with `NO_TIMEOUT`, spec D8) unsettleable, so the
    // pump never returns and a producing handler's `finally` never runs —
    // a leaked generator, and a leaked pending promise, per offending port.
    // This is the floor: it must fail if enforcement is missing entirely
    // (nothing ever aborts the peer's stalled call, so its own `finally`
    // trivially runs once its own consumer eventually walks away — the
    // assertion below is on the *offending server's* handler, which only
    // gets torn down by this task's enforcement).
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    let finallyRan = false;
    // A handler that keeps producing output (so its outbound pump has an
    // in-flight `callPort` call at the moment poison fires) while never
    // draining its input (so the first inbound chunk stays unconfirmed).
    const off = serveDuplexOverPort(channel.port2, async function* producer() {
      try {
        let i = 0;
        while (true) {
          yield enc.encode(String(i++));
        }
      } finally {
        finallyRan = true;
      }
    });
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });

    // Drain the outbound channel so the pump keeps calling `callPort`
    // (cooperative on "out"; the violation is only on "in").
    channel.port1.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as
        | { type?: string; channelName?: string; callId?: string }
        | undefined;
      if (data?.type === "request" && data.channelName === "out" && data.callId) {
        channel.port1.postMessage({
          type: "response:result",
          channelName: "out",
          callId: data.callId,
          result: undefined,
        });
      }
    });

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

    await waitFor("the producing handler's finally runs", () => finallyRan, 5000);
  }, 10_000);

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
