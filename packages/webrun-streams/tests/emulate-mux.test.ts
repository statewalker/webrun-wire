import { describe, expect, it } from "vitest";
import {
  type ByteChannel,
  collectBytes,
  type Duplex,
  emulateMux,
  TransportClosedError,
} from "../src/index.js";

const utf8 = new TextEncoder();

/** Creates a pair of in-memory ByteChannels piped to each other for tests. */
function makePipePair(): { a: ByteChannel; b: ByteChannel } {
  let closedResolveA!: () => void;
  let closedResolveB!: () => void;
  const closedA = new Promise<void>((r) => {
    closedResolveA = r;
  });
  const closedB = new Promise<void>((r) => {
    closedResolveB = r;
  });
  const queueA: Uint8Array[] = [];
  const queueB: Uint8Array[] = [];
  let pendingA: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  let pendingB: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  let closed = false;

  const deliverTo = (target: "a" | "b", bytes: Uint8Array): void => {
    if (closed) return;
    if (target === "a") {
      if (pendingA) {
        const r = pendingA;
        pendingA = null;
        r({ value: bytes, done: false });
      } else queueA.push(bytes);
    } else {
      if (pendingB) {
        const r = pendingB;
        pendingB = null;
        r({ value: bytes, done: false });
      } else queueB.push(bytes);
    }
  };

  const recvOf = (target: "a" | "b"): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          const queue = target === "a" ? queueA : queueB;
          if (queue.length > 0) {
            const value = queue.shift() as Uint8Array;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({
              value: undefined,
              done: true,
            } as IteratorResult<Uint8Array>);
          }
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            if (target === "a") pendingA = resolve;
            else pendingB = resolve;
          });
        },
      };
    },
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    pendingA?.({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    pendingB?.({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    pendingA = null;
    pendingB = null;
    closedResolveA();
    closedResolveB();
  };

  return {
    a: {
      send: (bytes) => deliverTo("b", bytes),
      recv: recvOf("a"),
      closed: closedA,
      close,
    },
    b: {
      send: (bytes) => deliverTo("a", bytes),
      recv: recvOf("b"),
      closed: closedB,
      close,
    },
  };
}

const echoHandler: Duplex = async function* (input) {
  for await (const chunk of input) yield chunk;
};

describe("emulateMux", () => {
  it("round-trips a single stream via echo handler", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    server.serve(echoHandler);
    const out = client.call([utf8.encode("hello world")]);
    expect(new TextDecoder().decode(await collectBytes(out))).toBe("hello world");
    await client.close();
    await server.close();
  });

  it("supports 10 concurrent calls", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    server.serve(echoHandler);
    const calls = Array.from({ length: 10 }, async (_, i) => {
      const out = client.call([utf8.encode(`body-${i}`)]);
      return new TextDecoder().decode(await collectBytes(out));
    });
    const results = await Promise.all(calls);
    for (let i = 0; i < 10; i++) {
      expect(results[i]).toBe(`body-${i}`);
    }
    await client.close();
    await server.close();
  });

  it("propagates handler errors with stack and fields preserved", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* errorHandler() {
      const err = new Error("boom");
      Object.assign(err, { status: 404 });
      if ((0 as number) === 0) throw err;
      yield new Uint8Array(0);
    });
    const out = client.call([new Uint8Array(0)]);
    await expect(async () => {
      for await (const _ of out) {
        /* drain */
      }
    }).rejects.toMatchObject({ message: "boom", status: 404 });
    await client.close();
    await server.close();
  });

  it("supports half-close: input exhausts before output", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* (input) {
      // Drain input.
      for await (const _ of input) {
        /* discard */
      }
      // Then yield chunks over time.
      yield utf8.encode("a");
      await new Promise((r) => setTimeout(r, 5));
      yield utf8.encode("b");
    });
    const out = client.call(
      (async function* () {
        yield utf8.encode("ping");
      })(),
    );
    const text = new TextDecoder().decode(await collectBytes(out));
    expect(text).toBe("ab");
    await client.close();
    await server.close();
  });

  it("propagates transport teardown to in-flight calls", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* (input) {
      for await (const c of input) {
        yield c;
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    const out = client.call(
      (async function* () {
        yield utf8.encode("x");
        await new Promise((r) => setTimeout(r, 100));
      })(),
    );
    // Start consuming and then close the transport.
    const consume = (async () => {
      for await (const _ of out) {
        await client.close();
      }
    })();
    await expect(consume).rejects.toBeInstanceOf(TransportClosedError);
    await server.close();
  });

  it("rejects open beyond maxStreams", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 2 });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* (input) {
      // Long-lived handler so streams stay open.
      for await (const c of input) yield c;
    });
    // Open two long-lived streams (don't drain them yet).
    const out1 = client.call(
      (async function* () {
        yield utf8.encode("a");
        await new Promise((r) => setTimeout(r, 200));
      })(),
    );
    const out2 = client.call(
      (async function* () {
        yield utf8.encode("b");
        await new Promise((r) => setTimeout(r, 200));
      })(),
    );
    // Third should fail.
    const out3 = client.call([new Uint8Array(0)]);
    await expect(async () => {
      for await (const _ of out3) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(RangeError);
    void out1;
    void out2;
    await client.close();
    await server.close();
  });
});

describe("stream-table lifecycle", () => {
  it("frees the client-side slot after a normally-completed call", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 2 });
    const server = emulateMux(b, { side: "responder", maxStreams: 2 });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    // Three sequential calls, each fully drained, against a table of 2.
    for (let i = 0; i < 3; i++) {
      const out = await collectBytes(client.call([utf8.encode(`call-${i}`)]));
      expect(new TextDecoder().decode(out)).toBe(`call-${i}`);
    }

    await client.close();
    await server.close();
  });

  it("frees the server-side slot after a normally-completed call", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 8 });
    const server = emulateMux(b, { side: "responder", maxStreams: 2 });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    // The server's table is the small one here, so exhaustion proves the
    // responder side leaks independently of the initiator.
    for (let i = 0; i < 3; i++) {
      const out = await collectBytes(client.call([utf8.encode(`s-${i}`)]));
      expect(new TextDecoder().decode(out)).toBe(`s-${i}`);
    }

    await client.close();
    await server.close();
  });

  it("keeps pumping outbound after the peer's END, and frees the slot at our own END", async () => {
    // The initiator must be able to sit half-closed-inbound while still
    // sending. Releasing on inbound END alone would set `closed`, which
    // pumpOutbound checks, and the remaining chunks would be dropped.
    //
    // Driven at frame level rather than through a handler: a handler that
    // ends its response while something else keeps draining is exactly the
    // shape runHandler now tears down, so it cannot produce this state.
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 1 });

    const TYPE_OPEN = 0x01;
    const TYPE_DATA = 0x02;
    const TYPE_ACK = 0x03;
    const TYPE_END = 0x04;
    const dec = new TextDecoder();
    const received: string[] = [];
    let sentEarlyEnd = false;

    // This hand-rolled peer must speak credit now: the client starts at zero
    // and sends nothing until an advertisement arrives.
    const ack = (id: number, credit: number): Uint8Array => {
      const frame = new Uint8Array(6);
      frame[0] = id;
      frame[1] = TYPE_ACK;
      new DataView(frame.buffer).setUint32(2, credit, false);
      return frame;
    };

    void (async () => {
      for await (const frame of b.recv) {
        const id = frame[0] as number;
        const type = frame[1];
        if (type === TYPE_OPEN) {
          b.send(ack(id, 64 * 1024));
        } else if (type === TYPE_DATA) {
          received.push(dec.decode(frame.subarray(2)));
          b.send(ack(id, frame.byteLength - 2));
          if (!sentEarlyEnd) {
            // Our side is done replying while theirs is still going.
            sentEarlyEnd = true;
            b.send(new Uint8Array([id, TYPE_END]));
          }
        }
      }
    })();

    async function* slowInput() {
      for (const part of ["one", "two", "three"]) {
        await new Promise((r) => setTimeout(r, 10));
        yield utf8.encode(part);
      }
    }

    const out = await collectBytes(client.call(slowInput()));
    expect(new TextDecoder().decode(out)).toBe("");
    await new Promise((r) => setTimeout(r, 60));
    // All three arrived: the early END did not truncate our outbound.
    expect(received.join(",")).toBe("one,two,three");

    // And the slot was freed at our own END, despite maxStreams: 1.
    const second = client.call([utf8.encode("after")]);
    await new Promise((r) => setTimeout(r, 30));
    expect(received.join(",")).toBe("one,two,three,after");
    await second.return(undefined);

    await client.close();
  });

  it("frees the slot when the caller cancels the response generator", async () => {
    // The documented way to abandon a call is `.return()` on the output, which
    // fires onCancel -> TYPE_CLOSE -> teardown. A caller that neither drains
    // nor cancels emits no observable signal at all: it never ACKs, so the
    // peer's pump blocks awaiting that ACK and no END is ever exchanged. That
    // is a caller-contract violation the mux cannot detect, not a leak.
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 2 });
    const server = emulateMux(b, { side: "responder", maxStreams: 8 });
    server.serve(async function* (input) {
      for await (const chunk of input) yield chunk;
    });

    for (let i = 0; i < 3; i++) {
      const out = client.call([utf8.encode(`cancelled-${i}`)]);
      await out.next();
      await out.return(undefined);
    }
    const out = await collectBytes(client.call([utf8.encode("still-works")]));
    expect(new TextDecoder().decode(out)).toBe("still-works");

    await client.close();
    await server.close();
  });

  it("frees the responder's slot when the caller cancels", async () => {
    // The cancel test above sizes the server table generously, so a
    // responder-side cancel leak would go unnoticed there.
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 8 });
    const server = emulateMux(b, { side: "responder", maxStreams: 1 });
    server.serve(async function* (input) {
      for await (const chunk of input) yield chunk;
    });

    for (let i = 0; i < 3; i++) {
      const out = client.call([utf8.encode(`cancel-${i}`)]);
      await out.next();
      await out.return(undefined);
      await new Promise((r) => setTimeout(r, 10));
    }
    const out = await collectBytes(client.call([utf8.encode("after-cancels")]));
    expect(new TextDecoder().decode(out)).toBe("after-cancels");

    await client.close();
    await server.close();
  });

  it("frees the slot on both peers when the handler throws", async () => {
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 1 });
    const server = emulateMux(b, { side: "responder", maxStreams: 1 });
    server.serve(async function* throwingHandler() {
      // Same shape as `errorHandler` above: the unreachable yield keeps this a
      // generator for the linter without changing behaviour.
      if ((0 as number) === 0) throw new Error("handler boom");
      yield new Uint8Array(0);
    });

    for (let i = 0; i < 3; i++) {
      await expect(collectBytes(client.call([utf8.encode("x")]))).rejects.toThrow(/handler boom/);
    }

    await client.close();
    await server.close();
  });
});
