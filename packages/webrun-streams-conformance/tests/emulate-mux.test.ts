import { type ByteChannel, emulateMux, TransportClosedError } from "@statewalker/webrun-streams";
import { describeDuplexAdapter, type MakePair } from "../src/index.js";

/** In-memory pipe pair, identical pattern to the unit-test helper in
 * webrun-streams. Used here to validate emulateMux passes the conformance
 * suite end-to-end before any real adapter is wired up. */
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
  let pendingA: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let pendingB: ((v: IteratorResult<Uint8Array>) => void) | null = null;
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
            return Promise.resolve({ value: queue.shift() as Uint8Array, done: false });
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

  const closeFn = (): void => {
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
    a: { send: (b) => deliverTo("b", b), recv: recvOf("a"), closed: closedA, close: closeFn },
    b: { send: (b) => deliverTo("a", b), recv: recvOf("b"), closed: closedB, close: closeFn },
  };
}

const makePair: MakePair = async () => {
  const { a, b } = makePipePair();
  const client = emulateMux(a, { side: "initiator" });
  const server = emulateMux(b, { side: "responder" });
  return {
    async connect() {
      return {
        call: client.call,
        close: async () => {
          await client.close();
        },
      };
    },
    async serve(handler) {
      return server.serve(handler);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
};

describeDuplexAdapter("emulateMux (in-process pipe)", makePair);

// Sanity: TransportClosedError is the named error class adapters surface.
void TransportClosedError;
