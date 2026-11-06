import { afterEach, describe, expect, it } from "vitest";
import {
  getPortCloseSignal,
  type MessageTarget,
  multiplexPort,
  type PortEnvelope,
  structuredCodec,
} from "../src/index.js";
import { endPort } from "../src/port-credit.js";

// `end` is agreed in a windowed port's `open` and its ack, as `pipeline` is.
// Where it was not agreed, `endPort` says so and sends nothing, and an `end`
// from the peer is a protocol violation: the port fails and closes.

const KiB = 1024;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(label: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function channel() {
  const ch = new MessageChannel();
  cleanups.push(() => {
    ch.port1.close();
    ch.port2.close();
  });
  return ch;
}

/** A peer written at the wire: posts envelopes, and records what comes back. */
function hostile(wire: MessagePort) {
  const received: PortEnvelope[] = [];
  wire.addEventListener("message", (e) => {
    const envelope = structuredCodec.read(e);
    if (envelope) received.push(envelope);
  });
  wire.start();
  return { post: (envelope: PortEnvelope) => wire.postMessage(envelope), received };
}

/** A new responder mux; resolves its ports as `onPort` accepts them. */
function responder(pipe: MessageTarget, window?: number) {
  const accepted: MessageTarget[] = [];
  const mux = multiplexPort(pipe, {
    codec: structuredCodec,
    side: "responder",
    ...(window ? { window } : {}),
    onPort: (port) => {
      accepted.push(port);
    },
  });
  cleanups.push(() => mux.close());
  return { mux, accepted };
}

describe("end in the windowed handshake", () => {
  it("a windowed open offers pipeline and end, and the ack answers both", async () => {
    const ch = channel();
    const peer = hostile(ch.port2);
    const a = multiplexPort(ch.port1, { codec: structuredCodec, window: 64 * KiB });
    cleanups.push(() => a.close());
    await a.openPort({ kind: "stream" });
    await waitFor("the open", () => peer.received.length > 0);
    expect(peer.received[0]).toMatchObject({ type: "open", caps: ["pipeline", "end"] });

    const ch2 = channel();
    const opener = hostile(ch2.port1);
    responder(ch2.port2);
    opener.post({ type: "open", id: 0, window: 64 * KiB, caps: ["pipeline", "end"] });
    await waitFor("the ack", () => opener.received.length > 0);
    expect(opener.received[0]).toEqual({
      type: "credit",
      id: 0,
      bytes: 0,
      caps: ["pipeline", "end"],
    });
  });

  it("endPort is false and sends nothing where end was not agreed", async () => {
    // No window at all.
    const plain = channel();
    const plainPeer = hostile(plain.port2);
    const noWindow = multiplexPort(plain.port1, { codec: structuredCodec });
    cleanups.push(() => noWindow.close());
    const bare = await noWindow.openPort({ kind: "stream" });
    expect(endPort(bare)).toBe(false);

    // A window whose ack answers only pipeline (a peer that does not speak end).
    const ch = channel();
    const peer = hostile(ch.port2);
    const a = multiplexPort(ch.port1, { codec: structuredCodec, window: 64 * KiB });
    cleanups.push(() => a.close());
    const port = await a.openPort({ kind: "stream" });
    // Before the ack nothing is agreed yet: false at once, never a wait.
    expect(endPort(port)).toBe(false);
    await waitFor("the open", () => peer.received.length > 0);
    peer.post({ type: "credit", id: 0, bytes: 0, caps: ["pipeline"] });
    await waitFor("the window is in force", () => a.ports()[0]?.window != null);
    expect(endPort(port)).toBe(false);
    // Still usable: what is posted after a refused end goes out.
    port.postMessage("after");
    await waitFor("the message", () => peer.received.some((e) => e.type === "message"));
    expect([...peer.received, ...plainPeer.received].some((e) => e.type === "end")).toBe(false);
  });

  it("endPort on a closed port is false and sends nothing", async () => {
    const ch = channel();
    const opener = hostile(ch.port1);
    const { accepted } = responder(ch.port2);
    opener.post({ type: "open", id: 0, window: 64 * KiB, caps: ["pipeline", "end"] });
    await waitFor("the port is accepted", () => accepted.length === 1);
    // biome-ignore lint/style/noNonNullAssertion: checked by the wait above.
    const port = accepted[0]!;
    port.close?.();
    expect(endPort(port)).toBe(false);
    await waitFor("the close", () => opener.received.some((e) => e.type === "close"));
    await new Promise((r) => setTimeout(r, 20));
    expect(opener.received.some((e) => e.type === "end")).toBe(false);
  });

  it.each([
    ["an opener that listed only pipeline", { window: 64 * KiB, caps: ["pipeline"] }],
    ["an opener that listed no capabilities", { window: 64 * KiB }],
    ["an opener with no window", {}],
  ])("an end from %s fails the port and closes it", async (_who, open) => {
    const ch = channel();
    const peer = hostile(ch.port1);
    const { mux, accepted } = responder(ch.port2);
    peer.post({ type: "open", id: 0, meta: { kind: "stream" }, ...open });
    await waitFor("the port is accepted", () => accepted.length === 1);
    // biome-ignore lint/style/noNonNullAssertion: checked by the wait above.
    const signal = getPortCloseSignal(accepted[0]!);
    peer.post({ type: "end", id: 0 });

    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(mux.ports()).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ message: expect.stringMatching(/end was not agreed/) });
  });

  it("an end from a responder whose ack did not agree it fails the port and closes it", async () => {
    const ch = channel();
    const peer = hostile(ch.port2);
    const a = multiplexPort(ch.port1, { codec: structuredCodec, window: 64 * KiB });
    cleanups.push(() => a.close());
    const port = await a.openPort({ kind: "stream" });
    const signal = getPortCloseSignal(port);
    await waitFor("the open", () => peer.received.length > 0);
    peer.post({ type: "credit", id: 0, bytes: 0, caps: ["pipeline"] });
    peer.post({ type: "end", id: 0 });

    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(a.ports()).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ message: expect.stringMatching(/end was not agreed/) });
  });
});
