import { describe, expect, it } from "vitest";
import { type ByteChannel, emulateMux } from "../src/index.js";

const utf8 = new TextEncoder();

// Flow control here is receiver-advertised credit. Each side puts its
// `maxStreamBuffer` in the frame it opens with (`OPEN`, and the `ACK` that
// answers it); the sender reserves credit before it frames anything and stalls
// at zero; the receiver grants more only once its consumer has actually
// drained — `slot.resolve(true)` runs after the `yield` returns. Without it a
// fast producer would run ahead of a slow consumer without limit.
//
// None of this was pinned by any test: removing the ACK await from
// pumpOutbound entirely left the whole suite green. These cover it.

const FRAME_NAMES: Record<number, string> = {
  1: "OPEN",
  2: "DATA",
  3: "ACK",
  4: "END",
  5: "ERROR",
  6: "CLOSE",
};

/** One credit-bearing ACK, as observed on the wire. */
interface Grant {
  dir: "A>B" | "B>A";
  credit: number;
}

function pipePair(): {
  a: ByteChannel;
  b: ByteChannel;
  frames: string[];
  grants: Grant[];
} {
  const qa: Uint8Array[] = [];
  const qb: Uint8Array[] = [];
  let pa: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let pb: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  const frames: string[] = [];
  const grants: Grant[] = [];
  const deliver = (t: "a" | "b", x: Uint8Array): void => {
    const dir = t === "b" ? "A>B" : "B>A";
    frames.push(`${dir}:${FRAME_NAMES[x[1]] ?? x[1]}`);
    // Single-byte stream ids only — every test here stays well under 128.
    if (x[1] === 3 && x.byteLength === 6) {
      grants.push({ dir, credit: new DataView(x.buffer, x.byteOffset + 2, 4).getUint32(0, false) });
    }
    const q = t === "a" ? qa : qb;
    const p = t === "a" ? pa : pb;
    if (p) {
      if (t === "a") pa = null;
      else pb = null;
      p({ value: x, done: false });
    } else q.push(x);
  };
  const recv = (t: "a" | "b"): AsyncIterable<Uint8Array> =>
    ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const q = t === "a" ? qa : qb;
          if (q.length) return Promise.resolve({ value: q.shift() as Uint8Array, done: false });
          return new Promise<IteratorResult<Uint8Array>>((r) => {
            if (t === "a") pa = r;
            else pb = r;
          });
        },
      }),
    }) as AsyncIterable<Uint8Array>;
  return {
    frames,
    grants,
    a: {
      send: (x) => deliver("b", x),
      recv: recv("a"),
      closed: new Promise<void>(() => {}),
      close: () => {},
    },
    b: {
      send: (x) => deliver("a", x),
      recv: recv("b"),
      closed: new Promise<void>(() => {}),
      close: () => {},
    },
  };
}

describe("backpressure", () => {
  it("a slow consumer throttles the producer, in the request direction", async () => {
    // NOTE: destructure `frames` from `pipePair()` here — the ERROR assertion
    // below needs it.
    const { a, b, frames } = pipePair();
    const client = emulateMux(a, { side: "initiator" });
    // ~8-byte chunks against a 32-byte window: about four may be in flight.
    // At the 8 MiB default the window is four orders of magnitude larger than
    // the whole stream and nothing would ever throttle.
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 32 });
    let produced = 0;
    let consumed = 0;
    server.serve(async function* slowConsumer(input) {
      for await (const _chunk of input) {
        consumed += 1;
        await new Promise((r) => setTimeout(r, 20));
      }
      yield new Uint8Array(0);
    });

    const gen = client.call(
      (async function* () {
        for (let i = 0; i < 50; i++) {
          produced += 1;
          yield utf8.encode(`chunk-${i}`);
        }
      })(),
    );
    await new Promise((r) => setTimeout(r, 100));
    const ahead = produced - consumed;
    await gen.return(undefined);

    // The producer may run up to one credit window ahead — 32 bytes, i.e.
    // four `chunk-NN` chunks, plus the one being framed.
    //
    // The upper bound alone does NOT pin credit: delete `reserve` from 3e and
    // this test still passes, because the receiver's maxStreamBuffer guard
    // tears the stream down and the teardown does the throttling. The two
    // assertions below are what make it a credit test rather than a cap test.
    expect(frames.filter((f) => f.endsWith(":ERROR")).length).toBe(0); // no teardown
    expect(produced).toBeGreaterThanOrEqual(4); // window really filled
    expect(consumed).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(6);
    expect(produced).toBeLessThan(50);

    await client.close();
    await server.close();
  });

  it("a slow consumer throttles the producer, in the response direction too", async () => {
    const { a, b, frames } = pipePair();
    // The client is the receiver in this direction, so the small window goes
    // on the client.
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 32 });
    const server = emulateMux(b, { side: "responder" });
    let produced = 0;
    server.serve(async function* fastProducer() {
      for (let i = 0; i < 50; i++) {
        produced += 1;
        yield utf8.encode(`r-${i}`);
      }
    });

    let consumed = 0;
    const gen = client.call([utf8.encode("go")]);
    void (async () => {
      for await (const _chunk of gen) {
        consumed += 1;
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    const ahead = produced - consumed;
    await gen.return(undefined);

    // `r-NN` is 3-4 bytes, so a 32-byte window holds eight to ten, plus the
    // one being framed — hence the bound of 11.
    //
    // As in 8c, the ERROR and floor assertions are what distinguish credit
    // from the buffer cap; without them this passes with `reserve` deleted.
    expect(frames.filter((f) => f.endsWith(":ERROR")).length).toBe(0);
    expect(produced).toBeGreaterThanOrEqual(8);
    expect(consumed).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(11);
    expect(produced).toBeLessThan(50);

    await client.close();
    await server.close();
  });

  it("sends up to the advertised credit and no further while the peer never drains", async () => {
    const { a, b, frames } = pipePair();
    const client = emulateMux(a, { side: "initiator" });
    // Four frames' worth of credit: the sender may fill it, then must stop.
    const server = emulateMux(b, {
      side: "responder",
      mtu: 64 * 1024,
      maxStreamBuffer: 4 * 64 * 1024,
    });
    server.serve(async function* neverDrains() {
      await new Promise((r) => setTimeout(r, 5_000));
    });

    const gen = client.call(
      (async function* () {
        for (let i = 0; i < 50; i++) yield new Uint8Array(64 * 1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* stream torn down */
      }
    })();
    await new Promise((r) => setTimeout(r, 60));

    // Unbounded sending would put all 50 on the wire. Credit bounds it to the
    // advertised window, and the consumer never drains so none is returned.
    const sentData = frames.filter((f) => f === "A>B:DATA").length;
    expect(sentData).toBeGreaterThan(1);
    expect(sentData).toBeLessThanOrEqual(4);

    await client.close();
    await server.close();
  });

  it("one stalled stream does not block another", async () => {
    const { a, b } = pipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    let invocations = 0;
    server.serve(async function* maybeStalls(input) {
      invocations += 1;
      if (invocations === 1) {
        await new Promise((r) => setTimeout(r, 5_000));
        return;
      }
      for await (const chunk of input) yield chunk;
    });

    const stalled = client.call(
      (async function* () {
        for (let i = 0; i < 100; i++) yield new Uint8Array(1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of stalled) {
          /* drain */
        }
      } catch {
        /* stream torn down */
      }
    })();
    await new Promise((r) => setTimeout(r, 30));

    const started = Date.now();
    let echoed = "";
    const dec = new TextDecoder();
    for await (const chunk of client.call([utf8.encode("independent")])) {
      echoed += dec.decode(chunk);
    }
    expect(echoed).toBe("independent");
    expect(Date.now() - started).toBeLessThan(500);

    await client.close();
    await server.close();
  });

  it("splits a chunk larger than mtu and gets credit back for every byte", async () => {
    const { a, b, frames, grants } = pipePair();
    const client = emulateMux(a, { side: "initiator", mtu: 1024 });
    // A 4 KiB window against an 8 KiB body: the sender genuinely stalls and
    // resumes several times, so the grants below are load-bearing.
    //
    // 4 KiB, not 2 KiB: the grantor's trigger is half the window, so a 2 KiB
    // window puts the trigger at exactly one 1 KiB mtu piece. Every single
    // drain then crosses it, batching is arithmetically impossible, and the
    // frame-economy bound below is unreachable (measured: 9 grants for 8
    // frames) whatever the `queueEmpty` flush does. At 4 KiB the trigger is
    // two pieces, sub-threshold drains exist, and the bound has something to
    // bite on.
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4096 });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    let total = 0;
    for await (const chunk of client.call([new Uint8Array(8 * 1024)])) total += chunk.byteLength;

    expect(total).toBe(8 * 1024);
    expect(frames.filter((f) => f === "A>B:DATA").length).toBe(8);
    // Credit returned by the responder is its 4096-byte advertisement plus
    // exactly one byte of grant per byte its handler drained. How the grants
    // are batched is an implementation detail; the total is not.
    const returned = grants.filter((g) => g.dir === "B>A").reduce((sum, g) => sum + g.credit, 0);
    expect(returned).toBe(4096 + 8 * 1024);
    // Frame economy — this is the ONLY integration coverage of `consumed`'s
    // `queueEmpty` argument. Hard-coding it to `true` restores one grant per
    // DATA frame (9 for 8) and the totals above stay green, so without this
    // bound the whole flush parameter is untested end to end.
    expect(grants.filter((g) => g.dir === "B>A").length).toBeLessThan(8);

    await client.close();
    await server.close();
  });
});
