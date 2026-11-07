import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  duplexOverPort,
  getPortCloseSignal,
  multiplexPort,
  STREAM_ABORT,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";
import { STREAM_WINDOW, streamPorts } from "./stream-ports.js";

const enc = new TextEncoder();

/** Poll a condition rather than waiting a fixed number of ticks (G13). */
async function waitFor(label: string, cond: () => boolean, ms = 2000): Promise<void> {
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

async function streamPair(windowed: boolean, handler: Duplex) {
  const channel = await streamPorts(windowed, open);
  const off = serveDuplexOverPort(channel.port2, handler);
  open.push(off);
  return { call: duplexOverPort(channel.port1), channel };
}

// Each case runs on a plain port and on a windowed one where both ends agreed
// `pipeline` and `end`: an abandoned stream aborts, notifies and closes alike.
describe.each([
  { windowed: false, mode: "no window" },
  { windowed: true, mode: "a window, pipeline and end agreed" },
])("duplexOverPort — cancellation ($mode)", ({ windowed }) => {
  it("a caller that stops iterating runs the handler's finally", async () => {
    let cleanupRan = false;
    const unbounded: Duplex = async function* unbounded() {
      try {
        while (true) {
          yield enc.encode("tick");
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        cleanupRan = true;
      }
    };
    const { call, channel } = await streamPair(windowed, unbounded);
    let count = 0;
    for await (const _ of call([new Uint8Array(0)])) {
      count++;
      if (count >= 3) break;
    }
    await waitFor("handler cleanup after caller break", () => cleanupRan);
    expect(count).toBe(3);
    expect(cleanupRan).toBe(true);
    if (windowed) {
      // Closed, not ended: the serving side learns of a close, never of a
      // normal finish.
      const closed = getPortCloseSignal(channel.port2);
      await waitFor("the serving side's port closed", () => closed?.aborted === true);
      expect(String(closed?.reason)).not.toMatch(/ended in both directions/);
    }
  });

  it("posts the abort notice on the port rather than relying on close", async () => {
    // The ceiling: the notice is observable on the wire. Its floor is the test
    // above — the handler's finally actually ran because of it.
    const seen: unknown[] = [];
    const channel = await streamPorts(windowed, open);
    channel.port2.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as { type?: unknown } | undefined;
      if (data?.type === STREAM_ABORT) seen.push(data);
    });
    const off = serveDuplexOverPort(channel.port2, async function* () {
      while (true) {
        yield enc.encode("tick");
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });
    let n = 0;
    for await (const _ of duplexOverPort(channel.port1)([new Uint8Array(0)])) {
      if (++n >= 2) break;
    }
    await waitFor("abort notice on the wire", () => seen.length > 0);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("a handler teardown wakes a caller that is still reading", async () => {
    const channel = await streamPorts(windowed, open);
    const off = serveDuplexOverPort(channel.port2, async function* () {
      while (true) {
        yield enc.encode("tick");
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    open.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    let ended = false;
    let failed: unknown;
    const consumer = (async () => {
      try {
        for await (const _ of duplexOverPort(channel.port1)([new Uint8Array(0)])) {
          /* read until the peer goes away */
        }
      } catch (e) {
        failed = e;
      } finally {
        ended = true;
      }
    })();
    await new Promise((r) => setTimeout(r, 40));
    off();
    await waitFor("caller woke after handler teardown", () => ended);
    await consumer;
    // Either outcome is correct — the stream ended, cleanly or with the
    // abandonment error. What must not happen is hanging forever.
    expect(ended).toBe(true);
    if (failed) expect(String(failed)).toMatch(/abandoned|closed|torn/);
  });

  it("teardown is idempotent, and notifies the peer exactly once", async () => {
    // The ceiling (does not throw) is not enough on its own — every primitive
    // teardownOnce touches (AbortController.abort, removeEventListener,
    // generator.return on a finished generator) is already independently
    // idempotent, so `.not.toThrow()` alone would pass even for a gutted
    // `off`. The floor is the peer-visible effect a caller actually depends
    // on: repeated teardown is safe *and* does not re-notify the peer.
    const channel = await streamPorts(windowed, open);
    const seen: unknown[] = [];
    channel.port1.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as { type?: unknown } | undefined;
      if (data?.type === STREAM_ABORT) seen.push(data);
    });
    const off = serveDuplexOverPort(channel.port2, async function* () {
      yield enc.encode("x");
    });
    open.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    expect(() => {
      off();
      off();
      off();
    }).not.toThrow();
    await waitFor("abort notice reaches the peer", () => seen.length > 0);
    expect(seen.length).toBe(1);
  });

  it("cancelling one stream over a mux leaves another stream working", async () => {
    // The isolation floor for every teardown assertion above.
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const window = windowed ? STREAM_WINDOW : undefined;
    const serverMux = multiplexPort(channel.port2, {
      codec: structuredCodec,
      side: "responder",
      window,
      onPort: (p) => {
        serveDuplexOverPort(p, async function* echoOrTick(input) {
          for await (const chunk of input) yield chunk;
          while (true) {
            yield enc.encode("tick");
            await new Promise((r) => setTimeout(r, 10));
          }
        });
      },
    });
    const clientMux = multiplexPort(channel.port1, {
      codec: structuredCodec,
      side: "initiator",
      window,
    });
    open.push(() => {
      void clientMux.close();
      void serverMux.close();
    });

    const first = duplexOverPort(await clientMux.openPort({ kind: "stream" }));
    let n = 0;
    for await (const _ of first([enc.encode("a")])) {
      if (++n >= 1) break;
    }

    const second = duplexOverPort(await clientMux.openPort({ kind: "stream" }));
    const chunks: string[] = [];
    for await (const chunk of second([enc.encode("still-here")])) {
      chunks.push(new TextDecoder().decode(chunk));
      break;
    }
    expect(chunks[0]).toBe("still-here");
  });
});
