import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { type DuplexOverPortOptions, duplexOverPort, serveDuplexOverPort } from "../src/index.js";

const enc = new TextEncoder();

/**
 * Poll a condition rather than waiting a fixed number of ticks (G13) — the
 * same house pattern as `duplex-over-port-cancel.test.ts`'s `waitFor`.
 *
 * Needed here because a handler's `finally` cannot run before its own
 * in-flight `await` settles: JS cannot preempt a generator that is suspended
 * on an unrelated Promise (confirmed empirically — see the task-4 report).
 * Calling `.return()` on such a generator only takes effect once that await
 * resolves, so checking `cleanupRan` synchronously right after the stream
 * rejects is a race, not an assertion.
 */
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

function streamPair(handler: Duplex, options: DuplexOverPortOptions = {}) {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const off = serveDuplexOverPort(channel.port2, handler, options);
  open.push(() => {
    off();
    channel.port1.close();
    channel.port2.close();
  });
  return duplexOverPort(channel.port1, options);
}

describe("duplexOverPort — the stream timeout (spec D8)", () => {
  it("F5: a consumer slower than the old 1000 ms default completes the transfer", async () => {
    // This is the regression that D8 exists for. It fails on the pre-B2 stack,
    // where every chunk carried callPort's 1000 ms deadline.
    const call = streamPair(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });
    const received: string[] = [];
    for await (const chunk of call([enc.encode("one"), enc.encode("two")])) {
      await new Promise((r) => setTimeout(r, 1200));
      received.push(new TextDecoder().decode(chunk));
    }
    expect(received.join("")).toBe("onetwo");
  }, 20_000);

  it("aborts a stream whose peer stalls past the configured timeout", async () => {
    let cleanupRan = false;
    const call = streamPair(
      async function* stalling(input) {
        try {
          for await (const _ of input) {
            /* drain */
          }
          await new Promise((r) => setTimeout(r, 5000));
          yield enc.encode("too late");
        } finally {
          cleanupRan = true;
        }
      },
      { timeout: 150 },
    );
    await expect(collectBytes(call([enc.encode("hi")]))).rejects.toThrow(
      /webrun-rpc: stream idle for 150 ms/,
    );
    // The handler's own `finally` cannot run until its unrelated 5 s sleep
    // settles (JS cannot preempt an in-flight await) — poll for it instead of
    // asserting it synchronously right after the rejection (G13).
    await waitFor("handler cleanup after peer stall", () => cleanupRan, 6000);
    expect(cleanupRan).toBe(true);
  }, 20_000);

  it("progress resets the clock: many slow-but-steady chunks complete", async () => {
    // The floor for the assertion above. Each gap is under the timeout, the
    // total is many times over it, and a non-resetting timer kills this.
    const call = streamPair(
      async function* steady() {
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 60));
          yield enc.encode(String(i));
        }
      },
      { timeout: 250 },
    );
    const out = await collectBytes(call([new Uint8Array(0)]));
    expect(new TextDecoder().decode(out)).toBe("01234567");
  }, 20_000);

  it("no timeout by default: a 1.5 s stall is not an error", async () => {
    const call = streamPair(async function* slowStart() {
      await new Promise((r) => setTimeout(r, 1500));
      yield enc.encode("eventually");
    });
    const out = await collectBytes(call([new Uint8Array(0)]));
    expect(new TextDecoder().decode(out)).toBe("eventually");
  }, 20_000);
});
