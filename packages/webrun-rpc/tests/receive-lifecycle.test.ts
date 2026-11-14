import { describe, expect, it } from "vitest";
import { callPort, NO_TIMEOUT } from "../src/call-port.js";
import { receive } from "../src/receive.js";

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const TIMED_OUT = Symbol("timed out");
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, tick(ms).then(() => TIMED_OUT)]);

describe("receive: lifecycle edges", () => {
  it("ends a stream at once when the signal fired before its first next()", async () => {
    const { port1, port2 } = newChannel();
    const abort = new AbortController();
    const outer = receive<number>(port2, { signal: abort.signal });
    try {
      const first = await outer.next();
      expect(first.done).toBe(false);
      const stream = first.value as AsyncGenerator<number>;
      abort.abort(); // before the stream's installer has run
      const r = await within(stream.next(), 300);
      expect(r).not.toBe(TIMED_OUT);
      expect((r as IteratorResult<number>).done).toBe(true);
    } finally {
      await outer.return(undefined as never);
      port1.close();
      port2.close();
    }
  });

  it("rejects a held chunk's call when the outer generator closes, rather than acknowledging it", async () => {
    const { port1, port2 } = newChannel();
    const outer = receive<number>(port2);
    try {
      const first = await outer.next();
      expect(first.done).toBe(false);
      // The chunk arrives before anyone reads the stream, so it is held.
      const call = callPort(port1, { done: false, value: 1 }, { timeout: NO_TIMEOUT });
      call.catch(() => {});
      await tick();
      await outer.return(undefined as never);
      const r = await within(
        call.then(
          () => "acknowledged",
          (e: Error) => e.message,
        ),
        300,
      );
      expect(r).toMatch(/closed/);
    } finally {
      port1.close();
      port2.close();
    }
  });
});
