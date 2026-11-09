import { afterEach, describe, expect, it } from "vitest";
import { getPortCloseSignal } from "../src/close-signal.js";
import type { MessageTarget } from "../src/message-target.js";
import { multiplexPort } from "../src/multiplex-port.js";
import { portBufferedAmount, whenPortReady } from "../src/port-credit.js";
import type { PortCodec, PortEnvelope, PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

// Per-port flow control (PortMuxOptions.window): a port has at most `window` bytes delivered
// to the other side and not yet consumed; the rest waits in its send queue.

const rawPorts: MessagePort[] = [];
const muxes: PortMux[] = [];
afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((m) => m.close()));
  for (const p of rawPorts.splice(0)) p.close();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** A codec that counts the envelopes it posts, by type. */
function counting(): PortCodec & { sent: Record<string, number> } {
  const sent: Record<string, number> = {};
  return {
    sent,
    post(port, envelope: PortEnvelope, transfer) {
      sent[envelope.type] = (sent[envelope.type] ?? 0) + 1;
      structuredCodec.post(port, envelope, transfer);
    },
    read: (e) => structuredCodec.read(e),
  };
}

/** Two muxes over a MessageChannel; the responder hands each accepted port to `onPort`. */
function pair(window: number | undefined, onPort: (p: MessageTarget) => void) {
  const ch = new MessageChannel();
  rawPorts.push(ch.port1, ch.port2);
  const codec = counting();
  const a = multiplexPort(ch.port1, { codec, side: "initiator", window });
  const b = multiplexPort(ch.port2, {
    codec: structuredCodec,
    side: "responder",
    window,
    onPort: (p) => {
      onPort(p);
      return true;
    },
  });
  muxes.push(a, b);
  return { a, b, codec };
}

const KiB = 1024;

/** The window holds from the peer's acknowledgement on, one round trip after the open. */
async function acknowledged(mux: PortMux, count = 1) {
  await waitFor(
    () => (mux.ports?.() ?? []).filter((p) => p.window != null).length >= count,
    "the peer acknowledges the window",
  );
}

describe("per-port window", () => {
  it("stops at the window while the consumer holds its messages, then resumes", async () => {
    const got: number[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { a } = pair(256 * KiB, (p) =>
      p.addEventListener("message", (e) => {
        got.push((e.data as Uint8Array).byteLength);
        return held; // consumed only once released
      }),
    );
    const port = await a.openPort();
    await acknowledged(a);
    for (let i = 0; i < 10; i++) port.postMessage(new Uint8Array(100 * KiB));
    await waitFor(() => got.length === 2, "two messages within the window");
    await new Promise((r) => setTimeout(r, 50));
    expect(got.length).toBe(2); // 3 × 100 KiB would exceed 256 KiB
    expect(portBufferedAmount(port)).toBe(8 * 100 * KiB);
    release();
    await whenPortReady(port);
    await waitFor(() => got.length === 10, "all ten after release");
    expect(portBufferedAmount(port)).toBe(0);
  });

  it("a stalled port does not hold up another port on the same mux", async () => {
    const pings: number[] = [];
    const { a } = pair(64 * KiB, (p) => {
      p.addEventListener("message", (e) => {
        const d = e.data as { k: string; n?: number };
        if (d.k === "stall") return new Promise(() => {}); // never consumed
        if (d.k === "ping") pings.push(d.n ?? 0);
      });
    });
    const bulk = await a.openPort();
    const ping = await a.openPort();
    await acknowledged(a, 2);
    // The bulk port spends its window and queues 10 MiB behind it.
    for (let i = 0; i < 160; i++) bulk.postMessage({ k: "stall", pad: "x".repeat(64 * KiB) });
    for (let n = 0; n < 100; n++) ping.postMessage({ k: "ping", n });
    await waitFor(() => pings.length === 100, "all pings");
    expect(portBufferedAmount(bulk)).toBeGreaterThan(9 * 1024 * KiB);
  });

  it("sends a message larger than the window once nothing else is outstanding", async () => {
    const got: number[] = [];
    const { a } = pair(16 * KiB, (p) =>
      p.addEventListener("message", (e) => {
        got.push((e.data as Uint8Array).byteLength);
      }),
    );
    const port = await a.openPort();
    port.postMessage(new Uint8Array(1024 * KiB));
    port.postMessage(new Uint8Array(1024 * KiB));
    await waitFor(() => got.length === 2, "both large messages");
  });

  it("returns credit in batches: far fewer credit envelopes than messages", async () => {
    let got = 0;
    const back = pair(256 * KiB, (p) =>
      p.addEventListener("message", () => {
        got++;
        p.postMessage("ok"); // the responder's sends are counted on its own codec, not here
      }),
    );
    const port = await back.a.openPort();
    let echoes = 0;
    port.addEventListener("message", () => {
      echoes++;
    });
    for (let i = 0; i < 10_000; i++) port.postMessage(new Uint8Array(100));
    await waitFor(() => got === 10_000 && echoes === 10_000, "10,000 messages and echoes");
    // The initiator grants credit for the responder's 10,000 echoes.
    expect(back.codec.sent.credit ?? 0).toBeGreaterThan(0);
    expect(back.codec.sent.credit ?? 0).toBeLessThan(200);
  });

  it("a close sends what is queued, in order, then the close, without waiting for credit", async () => {
    const got: number[] = [];
    let closed = false;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { a } = pair(64 * KiB, (p) => {
      p.addEventListener("message", (e) => {
        got.push((e.data as Uint8Array)[0]);
        return got.length === 1 ? held : undefined;
      });
      getPortCloseSignal(p)?.addEventListener("abort", () => {
        closed = true;
      });
    });
    const port = await a.openPort();
    await acknowledged(a);
    for (let i = 0; i < 5; i++) port.postMessage(new Uint8Array(40 * KiB).fill(i));
    expect(port.close).toBeTypeOf("function"); // the test is about a close: it must happen
    port.close?.();
    // A close sends what is queued at once, then the close, without waiting for
    // credit: the peer's listener holding its first message holds nothing up.
    await waitFor(() => got.length === 5 && closed, "the queue, then the close");
    expect(got).toEqual([0, 1, 2, 3, 4]);
    release();
  });

  it("without a window, nothing changes: no credit envelopes, no queue", async () => {
    let got = 0;
    const { a, codec } = pair(undefined, (p) =>
      p.addEventListener("message", () => {
        got++;
        return new Promise(() => {}); // never settles: irrelevant without a window
      }),
    );
    const port = await a.openPort();
    for (let i = 0; i < 100; i++) port.postMessage(new Uint8Array(64 * KiB));
    await waitFor(() => got === 100, "all 100");
    expect(portBufferedAmount(port)).toBe(0);
    expect(codec.sent.credit).toBeUndefined();
  });

  it("closing the mux releases senders waiting for room", async () => {
    const { a } = pair(16 * KiB, (p) => p.addEventListener("message", () => new Promise(() => {})));
    const port = await a.openPort();
    for (let i = 0; i < 4; i++) port.postMessage(new Uint8Array(16 * KiB));
    const ready = whenPortReady(port);
    await a.close();
    await expect(ready).resolves.toBeUndefined();
  });
});
