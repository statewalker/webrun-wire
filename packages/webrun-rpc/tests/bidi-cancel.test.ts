import { describe, expect, it } from "vitest";
import { callBidi } from "../src/call-bidi.js";
import { listenBidi } from "../src/listen-bidi.js";

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

/**
 * Diagnostic tests for the propagation of consumer-side cancellation
 * (iterator.return()) upstream through callBidi / ioSend / recieve.
 *
 * The contract these tests probe:
 *   - When a `for await` loop over `callBidi`'s output breaks, the producer
 *     should be told to stop generating chunks within a bounded time.
 *   - Resources on both sides should be released.
 *   - No call should hang indefinitely.
 */
describe("callBidi consumer-side cancellation propagation", () => {
  it("server stops generating after consumer breaks (with short timeout)", async () => {
    const { port1, port2 } = newChannel();

    let serverYielded = 0;
    let serverFinally = false;

    const close = listenBidi<undefined, number>(port1, async function* slowSeries() {
      try {
        for (let i = 0; ; i++) {
          serverYielded = i + 1;
          yield i;
        }
      } finally {
        serverFinally = true;
      }
    });

    try {
      const consumed: number[] = [];
      try {
        for await (const v of callBidi<undefined, number>(port2, [], {
          options: { timeout: 200 },
        })) {
          consumed.push(v);
          if (consumed.length >= 3) break;
        }
      } catch {
        // ok: we expect the underlying chunk-callPort to eventually time out
        // once the consumer stops acking — that should surface here.
      }
      // Give the framework up to 1s to detect closure and tear down.
      await new Promise((r) => setTimeout(r, 1000));
      expect(consumed.length).toBe(3);
      // The server should have stopped within a small number of extra yields.
      // Currently we expect this to FAIL because the framework doesn't signal
      // upstream — server keeps yielding until its callPort fails on the
      // hung consumer.
      expect(serverFinally).toBe(true);
      expect(serverYielded).toBeLessThan(20);
    } finally {
      close();
    }
  });

  it("callBidi rejects when server handler throws (no chunks yielded)", async () => {
    const { port1, port2 } = newChannel();
    const close = listenBidi<undefined, never>(port1, async () => {
      throw new Error("server boom");
    });
    try {
      await expect(
        (async () => {
          const out: unknown[] = [];
          for await (const v of callBidi<undefined, never>(port2, [], {
            options: { timeout: 2000 },
          })) {
            out.push(v);
          }
          return out;
        })(),
      ).rejects.toThrow(/server boom/);
    } finally {
      close();
    }
  });

  it("callBidi consumer returns within a bounded time after break", async () => {
    const { port1, port2 } = newChannel();

    const close = listenBidi<undefined, number>(port1, async function* infinite() {
      // Yield a value, then wait briefly to give consumer time to break.
      for (let i = 0; ; i++) {
        yield i;
        await new Promise((r) => setTimeout(r, 5));
      }
    });

    try {
      const iter = callBidi<undefined, number>(port2, [], {
        options: { timeout: 300 },
      });
      // Pull two values.
      await iter.next();
      await iter.next();
      // Now signal we're done — should release upstream within ~1s.
      const t0 = Date.now();
      const ret = await iter.return(undefined as never);
      const elapsed = Date.now() - t0;
      expect(ret.done).toBe(true);
      // Generous bound: 2s.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      close();
    }
  });
});
