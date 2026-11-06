import { afterEach, describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/message-target.js";
import { multiplexPort } from "../src/multiplex-port.js";
import { whenPortReady } from "../src/port-credit.js";
import type { PortCodec, PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

// What the window needs before it ships (#45): it must not stall against an
// older peer, `whenPortReady` must yield to the event loop, and a held window
// must be visible.

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

/** A peer from before the window: it reads `window` in an `open` but never sends credit. */
const olderPeerCodec: PortCodec = {
  post(port, envelope, transfer) {
    if (envelope.type === "credit") return;
    structuredCodec.post(port, envelope, transfer);
  },
  read: (e) => structuredCodec.read(e),
};

function pair(
  window: number,
  onPort: (p: MessageTarget) => void,
  responderCodec: PortCodec = structuredCodec,
) {
  const ch = new MessageChannel();
  rawPorts.push(ch.port1, ch.port2);
  const a = multiplexPort(ch.port1, { codec: structuredCodec, side: "initiator", window });
  const b = multiplexPort(ch.port2, {
    codec: responderCodec,
    side: "responder",
    onPort: (p) => {
      onPort(p);
      return true;
    },
  });
  muxes.push(a, b);
  return { a, b };
}

const KiB = 1024;

describe("compatibility with a peer that never sends credit", () => {
  it("a port that asked for a window does not stall: without the peer's ack it runs unwindowed", async () => {
    let got = 0;
    const { a } = pair(
      4 * KiB,
      (p) =>
        p.addEventListener("message", () => {
          got++;
        }),
      olderPeerCodec,
    );
    const port = await a.openPort();
    for (let i = 0; i < 50; i++) port.postMessage(new Uint8Array(KiB));
    await waitFor(() => got === 50, "every message arrives");
    expect(a.ports?.()[0]?.window).toBeUndefined();
  });

  it("with the peer's ack the window holds", async () => {
    let got = 0;
    const { a } = pair(4 * KiB, (p) =>
      p.addEventListener("message", () => {
        got++;
        return new Promise(() => {}); // never consumed
      }),
    );
    const port = await a.openPort();
    await waitFor(() => a.ports?.()[0]?.window === 4 * KiB, "the peer acknowledges the window");
    for (let i = 0; i < 50; i++) port.postMessage(new Uint8Array(KiB));
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(4);
  });
});

describe("whenPortReady", () => {
  it("yields a task even when the port has room", async () => {
    const { a } = pair(64 * KiB, () => {});
    const port = await a.openPort();
    let otherTaskRan = false;
    setTimeout(() => {
      otherTaskRan = true;
    }, 0);
    await new Promise((r) => setTimeout(r, 0)); // the timer above is due now
    otherTaskRan = false;
    setImmediate(() => {
      otherTaskRan = true;
    });
    await whenPortReady(port);
    expect(otherTaskRan).toBe(true);
  });
});

describe("a held window is visible", () => {
  it("ports() reports queued, outstanding and unconsumed bytes", async () => {
    const { a, b } = pair(4 * KiB, (p) =>
      p.addEventListener("message", () => new Promise(() => {})),
    );
    const port = await a.openPort({ kind: "held" });
    await waitFor(() => a.ports?.()[0]?.window != null, "the peer acknowledges the window");
    for (let i = 0; i < 6; i++) port.postMessage(new Uint8Array(KiB));
    await waitFor(() => (b.ports?.()[0]?.unconsumed ?? 0) === 4 * KiB, "peer holds the window");
    expect(a.ports?.()[0]).toMatchObject({ queued: 2 * KiB, outstanding: 4 * KiB });
  });
});

describe("closing a port whose window is spent", () => {
  it("delivers the queue, then the close, once credit comes back", async () => {
    const got: number[] = [];
    let peer: MessageTarget | undefined;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { a, b } = pair(2 * KiB, (p) => {
      peer = p;
      p.addEventListener("message", (e) => {
        got.push((e.data as Uint8Array)[0] ?? -1);
        return held;
      });
    });
    const port = await a.openPort();
    await waitFor(() => a.ports?.()[0]?.window != null, "the peer acknowledges the window");
    for (let i = 0; i < 5; i++) port.postMessage(new Uint8Array(KiB).fill(i));
    await port.close?.();
    await waitFor(() => got.length === 2, "the window's worth arrives");
    release();
    await waitFor(() => got.length === 5, "the queue drains after close");
    expect(got).toEqual([0, 1, 2, 3, 4]);
    await waitFor(() => b.ports?.().length === 0, "the close follows the queue");
    expect(peer).toBeDefined();
  });
});
