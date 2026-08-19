import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { describe, expect, it } from "vitest";
import { connect, serveConnections } from "../src/index.js";

async function node(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function drain(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks.map((c) => decoder.decode(c)).join("");
}

function singleChunkSource(payload: string): AsyncGenerator<Uint8Array> {
  return (async function* () {
    yield encoder.encode(payload);
  })();
}

interface HeldEchoHandlerState {
  /** Streams currently inside the handler, blocked before reading input. */
  active: number;
  /** The largest `active` ever reached — the registrar's real concurrent
   * ceiling for this run, not an artefact of request ordering. */
  peakConcurrency: number;
}

/**
 * A handler that holds every inbound stream open — blocked before it reads
 * its input — until the test explicitly calls `release()`. This is what
 * makes "N concurrently open streams" provable rather than incidental:
 * without the hold, nothing stops a batch of fast round trips from finishing
 * one after another well inside whatever cap is in force, which would pass
 * regardless of whether the option under test does anything at all. Since
 * nothing here ever finishes early, streams attempted beyond the registrar's
 * live limit are rejected for real, not merely "not yet gotten to".
 */
function makeHeldEchoHandler(): {
  handler: (input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>;
  state: HeldEchoHandlerState;
  release: () => void;
} {
  const state: HeldEchoHandlerState = { active: 0, peakConcurrency: 0 };
  let releaseFn: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const handler = async function* (input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    state.active++;
    state.peakConcurrency = Math.max(state.peakConcurrency, state.active);
    await gate;
    try {
      for await (const chunk of input) yield chunk;
    } finally {
      state.active--;
    }
  };

  return { handler, state, release: () => releaseFn() };
}

// A 2ms stagger between each dial spreads negotiation across event-loop
// ticks instead of firing 40 real TCP/Noise/Yamux handshakes in the same
// tick. A genuine synchronous burst was observed to be flaky in this sandbox
// — occasionally admitting nothing at all, and once crashing the process on
// an uncaught reset (a pre-existing rough edge in the reset path, unrelated
// to this change) — even well under the cap being tested. The stagger only
// spreads out when negotiation *starts*; it does not let any admitted stream
// finish early, since `makeHeldEchoHandler` never releases on its own.
const DIAL_STAGGER_MS = 2;
// How long to wait after the last dial before releasing the gate, so every
// negotiation — successful or reset — has settled and "peak" reflects a
// real concurrent snapshot rather than an arbitrary mid-flight moment.
const SETTLE_WAIT_MS = 300;

// Regression coverage for task 6a: serveConnections/connect gave no way to
// raise libp2p's default `maxInboundStreams` (32 per protocol per
// connection). Past that default, an inbound stream is reset rather than
// queued, so a consumer opening one stream per in-flight request starts
// seeing rejected calls at 33 concurrent requests with no way out. These two
// tests prove both halves of the fix: a raised cap actually admits more than
// 32 concurrent streams, and an unconfigured server still exhibits the
// libp2p default (so the pass-through doesn't quietly change existing
// behaviour).
describe("serveConnections maxInboundStreams", () => {
  it(
    "admits more than 32 concurrent inbound streams when maxInboundStreams is raised",
    async () => {
      const server = await node(true);
      const client = await node(false);
      const attempted = 40;

      try {
        const { handler, state, release } = makeHeldEchoHandler();
        // Comfortably above `attempted` so the cap itself is never the
        // bottleneck — this test is about proving the option is threaded
        // through and honoured, not about finding its exact boundary.
        const stop = await serveConnections({ node: server, maxInboundStreams: 48 }, () => handler);
        const addr = server.getMultiaddrs()[0];
        if (addr == null) throw new Error("server has no listen address");

        const conn = await connect({ node: client, peer: addr });
        try {
          const promises: Promise<string>[] = [];
          for (let i = 0; i < attempted; i++) {
            promises.push(drain(conn.call(singleChunkSource(`msg-${i}`))));
            await new Promise((r) => setTimeout(r, DIAL_STAGGER_MS));
          }
          // Give every negotiation a chance to reach the (blocked) handler
          // before releasing — otherwise "peak" could just be however many
          // happened to be in flight at an arbitrary moment.
          await new Promise((r) => setTimeout(r, SETTLE_WAIT_MS));
          release();

          const results = await Promise.all(promises);

          // Nothing was ever allowed to finish early, so this is genuinely
          // how many were open on the wire at once, not an accumulation over
          // time.
          expect(state.peakConcurrency).toBeGreaterThan(32);
          expect(state.peakConcurrency).toBe(attempted);
          expect(results).toEqual(Array.from({ length: attempted }, (_, i) => `msg-${i}`));
        } finally {
          await conn.close();
        }
        await stop();
      } finally {
        await Promise.allSettled([server.stop(), client.stop()]);
      }
    },
    20_000,
  );

  it(
    "leaves libp2p's default 32-stream cap in force when the option is not set",
    async () => {
      const server = await node(true);
      const client = await node(false);
      const attempted = 40;
      const defaultCap = 32;

      try {
        const { handler, state, release } = makeHeldEchoHandler();
        // No `maxInboundStreams` here — this is the "pass-through only, no
        // new default" half of the contract: an unconfigured server must
        // still reset streams past the 33rd concurrent one, exactly as it
        // did before this package exposed the option.
        const stop = await serveConnections({ node: server }, () => handler);
        const addr = server.getMultiaddrs()[0];
        if (addr == null) throw new Error("server has no listen address");

        const conn = await connect({ node: client, peer: addr });
        try {
          const promises: Promise<string>[] = [];
          for (let i = 0; i < attempted; i++) {
            promises.push(drain(conn.call(singleChunkSource(`msg-${i}`))));
            await new Promise((r) => setTimeout(r, DIAL_STAGGER_MS));
          }
          await new Promise((r) => setTimeout(r, SETTLE_WAIT_MS));
          release();

          const results = await Promise.allSettled(promises);
          const echoedCorrectly = results.filter(
            (r, i) => r.status === "fulfilled" && r.value === `msg-${i}`,
          ).length;

          // Same reasoning as above: nothing that made it into the handler
          // was ever allowed to finish early, so this is the registrar's
          // actual concurrent ceiling for this run.
          expect(state.peakConcurrency).toBe(defaultCap);
          expect(echoedCorrectly).toBe(defaultCap);
        } finally {
          await conn.close();
        }
        await stop();
      } finally {
        await Promise.allSettled([server.stop(), client.stop()]);
      }
    },
    20_000,
  );
});
