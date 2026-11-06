import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import * as v05 from "webrun-rpc-0-5";
import * as v07 from "webrun-rpc-0-7";
import * as v08 from "webrun-rpc-0-8";
import * as current from "../src/index.js";

// A new end paired with a real published `@statewalker/webrun-rpc`, installed
// under a devDependency alias: 0.7.0 and 0.8.0 speak the window but no
// capabilities, 0.5.1 has no window at all. The new end asks for a window; the
// old one must see the stream it has always seen — acknowledged chunks, then
// `done` and `close` — and nothing it could misread.

const KiB = 1024;
const WINDOW = 4 * KiB;
// More bytes each way than the window holds, so credit has to flow.
const CHUNKS = 40;
const CHUNK_SIZE = 500;

type Rpc = Pick<typeof current, "connect" | "serve" | "overPipe" | "structuredCodec">;

/** An envelope as it arrived on one end's pipe; `to` says which end got it. */
type Seen = {
  to: "new" | "old";
  envelope: {
    type?: string;
    id?: number;
    caps?: unknown;
    window?: number;
    payload?: { type?: string; channelName?: string };
  };
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const echo: Duplex = async function* (input) {
  for await (const chunk of input) yield chunk;
};

/**
 * `connect` on one end and `serve(echo)` on the other, over one real
 * `MessageChannel`. Every envelope either end receives is logged, in order.
 * `window` is given to every end whose version has the option.
 */
async function pair(opener: Rpc, responder: Rpc, newRole: "opener" | "responder") {
  const ch = new MessageChannel();
  const wire: Seen[] = [];
  const openerGets = newRole === "opener" ? "new" : "old";
  const responderGets = newRole === "opener" ? "old" : "new";
  ch.port1.addEventListener("message", (e) => wire.push({ to: openerGets, envelope: e.data }));
  ch.port2.addEventListener("message", (e) => wire.push({ to: responderGets, envelope: e.data }));
  // Each end places envelopes with its own version's codec.
  const teardown = await responder.serve(
    {
      mux: responder.overPipe(ch.port2, {
        codec: responder.structuredCodec,
        side: "responder",
        window: WINDOW,
      }),
    },
    echo,
  );
  const { call, close } = await opener.connect({
    mux: opener.overPipe(ch.port1, {
      codec: opener.structuredCodec,
      side: "initiator",
      window: WINDOW,
    }),
  });
  cleanups.push(async () => {
    await close();
    await teardown();
    ch.port1.close();
    ch.port2.close();
  });
  return { call, wire };
}

async function runEcho(call: (input: Iterable<Uint8Array>) => AsyncIterable<Uint8Array>) {
  const input = Array.from({ length: CHUNKS }, (_, i) => new Uint8Array(CHUNK_SIZE).fill(i));
  const seen: number[] = [];
  for await (const chunk of call(input)) seen.push(...chunk);
  expect(seen).toEqual(input.flatMap((c) => [...c]));
}

/** Waits until the stream's port has been closed over the wire. */
async function closed(wire: Seen[]) {
  while (!wire.some((s) => s.envelope.type === "close")) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Nothing the old end could misread crossed the wire, in either direction. */
function expectNothingNew(wire: Seen[]) {
  for (const { to, envelope } of wire) {
    // The new opener's offer is the one place `caps` may appear: an old
    // responder ignores the field. No answer to it ever carries `caps`.
    if (!(to === "old" && envelope.type === "open")) {
      expect(envelope.caps, `${envelope.type} to ${to}`).toBeUndefined();
    }
    expect(envelope.type).not.toBe("end");
    expect(envelope.payload?.type).not.toBe("webrun-rpc:chunk");
  }
}

/** Confirmations of the caller's chunks (`in`) and the handler's (`out`), plus each `done`. */
function confirmations(wire: Seen[]) {
  const count = (channelName: string) =>
    wire.filter(
      (s) =>
        s.envelope.payload?.type === "response:result" &&
        s.envelope.payload.channelName === channelName,
    ).length;
  return { in: count("in"), out: count("out") };
}

for (const [version, old] of [
  ["0.7.0", v07],
  ["0.8.0", v08],
] as const) {
  describe(`mixed versions — paired with ${version} (window, no capabilities)`, () => {
    it(`new opener, ${version} responder: acknowledged chunks, done, close`, async () => {
      const { call, wire } = await pair(current, old as unknown as Rpc, "opener");
      await runEcho(call);
      await closed(wire);

      const open = wire.find((s) => s.to === "old" && s.envelope.type === "open");
      expect(open?.envelope.window).toBe(WINDOW);
      expect(open?.envelope.caps).toEqual(expect.arrayContaining(["pipeline"]));
      const ack = wire.find((s) => s.to === "new" && s.envelope.type === "credit");
      expect(ack).toBeDefined();
      expectNothingNew(wire);
      expect(confirmations(wire)).toEqual({ in: CHUNKS + 1, out: CHUNKS + 1 });
    });

    it(`${version} opener, new responder: acknowledged chunks, done, close`, async () => {
      const { call, wire } = await pair(old as unknown as Rpc, current, "responder");
      await runEcho(call);
      await closed(wire);

      const open = wire.find((s) => s.to === "new" && s.envelope.type === "open");
      expect(open?.envelope.window).toBe(WINDOW);
      const ack = wire.find((s) => s.to === "old" && s.envelope.type === "credit");
      expect(ack).toBeDefined();
      expectNothingNew(wire);
      expect(confirmations(wire)).toEqual({ in: CHUNKS + 1, out: CHUNKS + 1 });
    });
  });
}

describe("mixed versions — paired with 0.5.1 (no window)", () => {
  it("new opener asking for a window, 0.5.1 responder: the first chunk goes before anything comes back, and the stream completes", {
    timeout: 5000,
  }, async () => {
    const { call, wire } = await pair(current, v05 as unknown as Rpc, "opener");
    await runEcho(call);
    await closed(wire);

    const open = wire.findIndex((s) => s.to === "old" && s.envelope.type === "open");
    expect(wire[open]?.envelope.window).toBe(WINDOW);
    const firstChunk = wire.findIndex(
      (s) => s.to === "old" && s.envelope.payload?.channelName === "in",
    );
    const firstBack = wire.findIndex((s) => s.to === "new");
    expect(firstChunk).toBeGreaterThan(open);
    expect(firstChunk).toBeLessThan(firstBack);
    // 0.5.1 never acks the window, and more than a window went out with no
    // credit back: the new end did not hold its sends to it. (The new end
    // still grants credit for what it reads; 0.5.1's codec drops `credit`.)
    expect(wire.some((s) => s.to === "new" && s.envelope.type === "credit")).toBe(false);
    expect(CHUNKS * CHUNK_SIZE).toBeGreaterThan(WINDOW);
    expectNothingNew(wire);
    expect(confirmations(wire)).toEqual({ in: CHUNKS + 1, out: CHUNKS + 1 });
  });
});
