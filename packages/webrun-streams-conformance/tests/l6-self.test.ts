import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { type MakePair, makeLoopbackPair, measureRunAhead } from "../src/index.js";

/** Pumps `source` into an unbounded queue, one chunk every `everyMs`, whether or not anyone reads. */
function eagerSlowPump(
  source: AsyncIterable<Uint8Array>,
  everyMs: number,
): AsyncIterable<Uint8Array> {
  const queue: Uint8Array[] = [];
  let done = false;
  let wake: (() => void) | undefined;
  void (async () => {
    for await (const chunk of source) {
      queue.push(chunk);
      wake?.();
      await new Promise((r) => setTimeout(r, everyMs));
    }
    done = true;
    wake?.();
  })();
  return (async function* () {
    for (;;) {
      if (queue.length) yield queue.shift() as Uint8Array;
      else if (done) return;
      else await new Promise<void>((r) => (wake = r));
    }
  })();
}

/** A loopback pair whose transport buffers without bound, pulling slowly, yet declares 8 KiB. */
const slowUnbounded: MakePair = async () => {
  const inner = await makeLoopbackPair();
  return {
    ...inner,
    runAheadBytes: 8192,
    async serve(handler: Duplex) {
      return inner.serve(
        (input) =>
          eagerSlowPump(handler(eagerSlowPump(input, 150)), 150) as AsyncGenerator<Uint8Array>,
      );
    },
  };
};

/** A loopback pair that delivers chunk 6's bytes in place of chunk 5's (a duplicate and a drop). */
const corrupting: MakePair = async () => {
  const inner = await makeLoopbackPair();
  const swap = async function* (source: AsyncIterable<Uint8Array>) {
    let i = 0;
    let held: Uint8Array | undefined;
    for await (const chunk of source) {
      if (i === 5) held = chunk;
      else if (i === 6 && held) {
        yield chunk;
        yield chunk;
      } else yield chunk;
      i++;
    }
  };
  return {
    ...inner,
    async serve(handler: Duplex) {
      return inner.serve((input) => swap(handler(swap(input))) as AsyncGenerator<Uint8Array>);
    },
  };
};

describe("L6 fails what it should (review of #108)", () => {
  for (const direction of ["response", "request"] as const) {
    it(`${direction}: a slow, unbounded transport is caught past its declared bound`, async () => {
      const r = await measureRunAhead(slowUnbounded, direction);
      expect(r.ahead).toBeGreaterThan(8192);
    }, 30_000);

    it(`${direction}: a duplicated-and-dropped chunk is caught`, async () => {
      const r = await measureRunAhead(corrupting, direction);
      expect(r.intact).toBe(false);
    }, 30_000);

    it(`${direction}: the loopback pair measures 0 ahead, complete and intact`, async () => {
      const r = await measureRunAhead(makeLoopbackPair, direction);
      expect(r).toMatchObject({ ahead: 0, complete: true, intact: true });
    }, 30_000);
  }
});
