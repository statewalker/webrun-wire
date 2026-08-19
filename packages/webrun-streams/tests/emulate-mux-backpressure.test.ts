import { describe, expect, it } from "vitest";
import { type ByteChannel, emulateMux } from "../src/index.js";

const utf8 = new TextEncoder();

// Flow control here is one in-flight DATA frame per stream: the sender waits
// for an ACK, and the ACK is sent only once the consumer has pulled PAST that
// chunk (`slot.resolve(true)` runs after the `yield` returns). Without it a
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

function pipePair(): { a: ByteChannel; b: ByteChannel; frames: string[] } {
  const qa: Uint8Array[] = [];
  const qb: Uint8Array[] = [];
  let pa: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let pb: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  const frames: string[] = [];
  const deliver = (t: "a" | "b", x: Uint8Array): void => {
    frames.push(`${t === "b" ? "A>B" : "B>A"}:${FRAME_NAMES[x[1]] ?? x[1]}`);
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
    const { a, b } = pipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
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

    // The producer may sit one chunk ahead (the in-flight one). Far more than
    // that means it is not waiting for ACKs at all.
    expect(consumed).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(2);
    expect(produced).toBeLessThan(50);

    await client.close();
    await server.close();
  });

  it("a slow consumer throttles the producer, in the response direction too", async () => {
    const { a, b } = pipePair();
    const client = emulateMux(a, { side: "initiator" });
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

    expect(consumed).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(2);
    expect(produced).toBeLessThan(50);

    await client.close();
    await server.close();
  });

  it("holds exactly one DATA frame in flight while the peer never acks", async () => {
    const { a, b, frames } = pipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
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

    // Unbounded sending would put all 50 on the wire; flow control puts one.
    expect(frames.filter((f) => f === "A>B:DATA").length).toBe(1);

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

  it("splits a chunk larger than mtu and acks each piece", async () => {
    const { a, b, frames } = pipePair();
    const client = emulateMux(a, { side: "initiator", mtu: 1024 });
    const server = emulateMux(b, { side: "responder", mtu: 1024 });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    let total = 0;
    for await (const chunk of client.call([new Uint8Array(8 * 1024)])) total += chunk.byteLength;

    expect(total).toBe(8 * 1024);
    expect(frames.filter((f) => f === "A>B:DATA").length).toBe(8);
    expect(frames.filter((f) => f === "B>A:ACK").length).toBe(8);

    await client.close();
    await server.close();
  });
});
