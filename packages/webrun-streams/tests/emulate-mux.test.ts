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
