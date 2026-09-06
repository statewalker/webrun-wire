import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    // Deliberately no `cleanupRan`/`finally` assertion here (see fix-round-1
    // note in the task-4 report): the handler's own `finally` cannot run
    // before its unrelated 5 s sleep settles — JS cannot preempt a generator
    // suspended on an in-flight `await` — so `cleanupRan` flips `true` at
    // ~5000-5015 ms *regardless* of whether the 150 ms clock ever fired. A
    // build with the timeout machinery removed entirely (no abort, the
    // stream just resolves "too late") still flips it at ~5000 ms. It cannot
    // discriminate the two worlds, so it would only be decoration.
    //
    // What actually proves the 150 ms clock fired is that the rejection
    // lands far under that ~5 s natural-completion time. The margin is wide
    // (well under half the natural-completion time) so this can't flake on
    // a loaded machine, while still being tight enough that only the
    // configured 150 ms clock — not the fixture's own sleep — explains it.
    const call = streamPair(
      async function* stalling(input) {
        for await (const _ of input) {
          /* drain */
        }
        await new Promise((r) => setTimeout(r, 5000));
        yield enc.encode("too late");
      },
      { timeout: 150 },
    );
    const startedAt = Date.now();
    await expect(collectBytes(call([enc.encode("hi")]))).rejects.toThrow(
      /webrun-rpc: stream idle for 150 ms/,
    );
    expect(Date.now() - startedAt).toBeLessThan(1000);
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

  it("disarms the inactivity clock once a stream completes normally (no timer leak)", async () => {
    // Fix-round-1 finding: `serveDuplexOverPort`'s `clock.stop()` was only
    // reachable through its returned teardown. A stream that finishes
    // normally, with nobody left to call that teardown, left the last
    // `touch()`'s timer armed for up to `timeout` ms after real completion —
    // holding the event loop open for nothing. This proves it's disarmed by
    // watching every `setTimeout`/`clearTimeout` call at the configured
    // 5000 ms delay, without waiting the full 5 s out.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed = new Set<ReturnType<typeof setTimeout>>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const handle = realSetTimeout(fn, ms, ...args);
      if (ms === 5000) armed.add(handle);
      return handle;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      handle: Parameters<typeof clearTimeout>[0],
    ) => {
      armed.delete(handle as ReturnType<typeof setTimeout>);
      return realClearTimeout(handle);
    }) as typeof clearTimeout);

    try {
      const call = streamPair(
        async function* echo(input) {
          for await (const chunk of input) yield chunk;
        },
        { timeout: 5000 },
      );
      // Floor: the clock machinery actually armed a 5 s timer for this
      // stream. Without this, a build where the timeout is never armed at
      // all (broken outright) would trivially pass the "zero after
      // completion" check below for the wrong reason.
      expect(armed.size).toBeGreaterThan(0);

      const out = await collectBytes(call([enc.encode("hi")]));
      expect(new TextDecoder().decode(out)).toBe("hi");

      // The disarm runs off a `Promise.allSettled(...).then()` — one more
      // turn of the microtask queue past `collectBytes` resolving. Poll
      // rather than assert immediately (G13).
      await waitFor("clock disarmed after normal completion", () => armed.size === 0, 500);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  }, 20_000);

  it("disarms the clock when the handler stops pulling input before the wire says done", async () => {
    // Fix-round-2 finding: `ended` (added in round 1) resolved only on the
    // wire's own `done` chunk or on abort. A handler that stops consuming
    // input early — reads one chunk and returns, without the wire ever
    // saying `done` — left `ended` permanently unresolved: `off()` had
    // already removed both the port listener and the abort listener that
    // would otherwise have resolved it, so nothing was left to settle it.
    // `Promise.allSettled([pump, inbound.ended])` then waited forever, and
    // the clock stayed armed for the rest of `timeout` ms after the stream
    // had genuinely, normally completed. The caller intentionally has no
    // timeout of its own here, so the spy attributes every armed 2000 ms
    // timer unambiguously to the serve side under test.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed = new Set<ReturnType<typeof setTimeout>>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const handle = realSetTimeout(fn, ms, ...args);
      if (ms === 2000) armed.add(handle);
      return handle;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      handle: Parameters<typeof clearTimeout>[0],
    ) => {
      armed.delete(handle as ReturnType<typeof setTimeout>);
      return realClearTimeout(handle);
    }) as typeof clearTimeout);

    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = serveDuplexOverPort(
      channel.port2,
      async function* takeOne(input) {
        for await (const c of input) {
          yield c;
          break;
        }
      },
      { timeout: 2000 },
    );
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });
    const call = duplexOverPort(channel.port1); // deliberately no timeout here

    try {
      // Floor: the clock machinery actually armed a 2 s timer for this
      // stream. Without this, a build where the timeout is never armed at
      // all would trivially pass the "zero after completion" check below.
      expect(armed.size).toBeGreaterThan(0);

      // Three chunks sent, but the handler only ever pulls the first one.
      const out = await collectBytes(call([enc.encode("a"), enc.encode("b"), enc.encode("c")]));
      expect(new TextDecoder().decode(out)).toBe("a");

      await waitFor(
        "clock disarmed after handler stopped pulling early",
        () => armed.size === 0,
        500,
      );
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  }, 20_000);
});
