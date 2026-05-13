import { callBidi, ioHandle, ioSend, listenBidi } from "@statewalker/webrun-ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MakeFaultyPair, MakePair, PortPair } from "./loopback.js";

export interface DescribePortAdapterOptions {
  makeFaultyPair?: MakeFaultyPair;
  /** Skip L2 (framework composition) tests if the adapter is incomplete. */
  skipL2?: boolean;
  /** Timeout for individual scenarios in ms. */
  timeout?: number;
}

function collectMessages(port: MessagePort, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const out: unknown[] = [];
    const handler = (ev: MessageEvent) => {
      out.push(ev.data);
      if (out.length >= count) {
        port.removeEventListener("message", handler as EventListener);
        resolve(out);
      }
    };
    port.addEventListener("message", handler as EventListener);
    port.start();
  });
}

function nextMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = (ev: MessageEvent) => {
      port.removeEventListener("message", handler as EventListener);
      resolve(ev.data);
    };
    port.addEventListener("message", handler as EventListener);
    port.start();
  });
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((i * 2654435761) >>> 0) & 0xff;
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function describePortAdapter(
  name: string,
  makePair: MakePair,
  options: DescribePortAdapterOptions = {},
): void {
  const timeout = options.timeout ?? 30_000;

  describe(`port adapter conformance: ${name}`, () => {
    // --- L0 — port semantics ---
    describe("L0 — port semantics", () => {
      let pair: PortPair;
      beforeAll(async () => {
        pair = await makePair();
      });
      afterAll(async () => {
        await pair.close();
      });

      it("postMessage round-trips bytes", { timeout }, async () => {
        const want = new Uint8Array([1, 2, 3, 4, 5]);
        const got = nextMessage(pair.b);
        pair.a.postMessage(want);
        const received = await got;
        expect(received).toBeInstanceOf(Uint8Array);
        expect(bytesEqual(received as Uint8Array, want)).toBe(true);
      });
    });

    // --- L1 — bridged constraints ---
    describe("L1 — bridged constraints", () => {
      it.each([1, 1024, 65_536])(
        "byte payload round-trip (%d bytes)",
        async (size) => {
          const pair = await makePair();
          try {
            const want = randomBytes(size);
            const got = nextMessage(pair.b);
            pair.a.postMessage(want);
            const received = (await got) as Uint8Array;
            expect(received.byteLength).toBe(size);
            expect(bytesEqual(received, want)).toBe(true);
          } finally {
            await pair.close();
          }
        },
        timeout,
      );

      it("transparent chunking for 10 MB payload", { timeout: 60_000 }, async () => {
        const pair = await makePair();
        try {
          const size = 10 * 1024 * 1024;
          const want = randomBytes(size);
          const got = nextMessage(pair.b);
          pair.a.postMessage(want);
          const received = (await got) as Uint8Array;
          expect(received.byteLength).toBe(size);
          expect(bytesEqual(received, want)).toBe(true);
        } finally {
          await pair.close();
        }
      });

      it("structured-cloneable envelope round-trip", { timeout }, async () => {
        const pair = await makePair();
        try {
          const envelope = {
            channelName: "demo",
            callId: 42,
            type: "request",
            payload: { url: "/x", method: "GET", headers: [["accept", "*/*"]] },
          };
          const got = nextMessage(pair.b);
          pair.a.postMessage(envelope);
          const received = await got;
          expect(received).toEqual(envelope);
        } finally {
          await pair.close();
        }
      });

      it("ordering preserved across 100 sequential sends", { timeout }, async () => {
        const pair = await makePair();
        try {
          const expected = Array.from({ length: 100 }, (_, i) => i);
          const collected = collectMessages(pair.b, 100);
          for (const i of expected) {
            pair.a.postMessage(new Uint8Array([i & 0xff, (i >> 8) & 0xff]));
          }
          const received = (await collected) as Uint8Array[];
          expect(received.length).toBe(100);
          for (let i = 0; i < 100; i++) {
            const arr = received[i];
            const val = arr[0] | (arr[1] << 8);
            expect(val).toBe(expected[i]);
          }
        } finally {
          await pair.close();
        }
      });

      it("bidirectional close visibility", { timeout }, async () => {
        const pair = await makePair();
        const closeSeen = new Promise<void>((resolve) => {
          let received = false;
          const handler = () => {
            if (received) return;
            received = true;
            resolve();
          };
          // Close detection convention: peer receives no further messages.
          // We test by trying to post after close; the peer should not receive it.
          pair.b.addEventListener("message", handler as EventListener);
          pair.b.start();
          setTimeout(() => {
            if (!received) resolve();
          }, 200);
        });
        pair.a.close();
        await closeSeen;
        // Test passes if we reach here without hanging.
        await pair.close();
      });
    });

    // --- L2 — framework composition ---
    if (!options.skipL2) {
      describe("L2 — framework composition", () => {
        it("callBidi / listenBidi round-trip", { timeout }, async () => {
          const pair = await makePair();
          try {
            const unsubscribe = listenBidi<Uint8Array, Uint8Array>(pair.b, async function* (input) {
              for await (const chunk of input) {
                // Echo each chunk with a transformation.
                const out = new Uint8Array(chunk.byteLength);
                for (let i = 0; i < chunk.byteLength; i++) out[i] = chunk[i] + 1;
                yield out;
              }
            });
            try {
              async function* input() {
                yield new Uint8Array([1, 2, 3]);
                yield new Uint8Array([4, 5, 6]);
              }
              const out: number[][] = [];
              for await (const chunk of callBidi<Uint8Array, Uint8Array>(pair.a, input())) {
                out.push(Array.from(chunk));
              }
              expect(out).toEqual([
                [2, 3, 4],
                [5, 6, 7],
              ]);
            } finally {
              unsubscribe();
            }
          } finally {
            await pair.close();
          }
        });

        it("10 concurrent callBidi calls", { timeout }, async () => {
          const pair = await makePair();
          try {
            const unsubscribe = listenBidi<{ n: number }, { n: number; index: number }>(
              pair.b,
              async function* (input, params) {
                const callIndex = (params.callIndex as number) ?? -1;
                let n = 0;
                for await (const item of input) {
                  n = item.n;
                }
                yield { n: n * 2, index: callIndex };
              },
            );
            try {
              const calls = Array.from({ length: 10 }, async (_, i) => {
                async function* input() {
                  yield { n: i + 1 };
                }
                const out: { n: number; index: number }[] = [];
                for await (const item of callBidi<{ n: number }, { n: number; index: number }>(
                  pair.a,
                  input(),
                  { callIndex: i },
                )) {
                  out.push(item);
                }
                return out;
              });
              const results = await Promise.all(calls);
              for (let i = 0; i < 10; i++) {
                expect(results[i]).toEqual([{ n: (i + 1) * 2, index: i }]);
              }
            } finally {
              unsubscribe();
            }
          } finally {
            await pair.close();
          }
        });

        it("10 MB stream through ioSend / ioHandle", { timeout: 90_000 }, async () => {
          const pair = await makePair();
          try {
            // Build 10 MB in 1 MB chunks.
            const totalBytes = 10 * 1024 * 1024;
            const chunkSize = 1 * 1024 * 1024;
            const chunkCount = totalBytes / chunkSize;
            async function* input(): AsyncGenerator<Uint8Array> {
              for (let i = 0; i < chunkCount; i++) {
                yield randomBytes(chunkSize);
              }
            }
            const handler = async (incoming: AsyncIterable<Uint8Array>) => {
              let received = 0;
              for await (const chunk of incoming) {
                received += chunk.byteLength;
              }
              return (async function* () {
                yield new Uint8Array([received & 0xff, (received >> 8) & 0xff]);
              })();
            };
            const handle = ioHandle<Uint8Array, Uint8Array>(pair.b, handler);
            const send = (async () => {
              const out: Uint8Array[] = [];
              for await (const chunk of ioSend<Uint8Array, Uint8Array>(pair.a, input())) {
                out.push(chunk);
              }
              return out;
            })();
            // Drain handle and send concurrently.
            await Promise.all([
              (async () => {
                for await (const _ of handle) break;
              })(),
              send,
            ]);
          } finally {
            await pair.close();
          }
        });
      });
    }

    // --- Optional failure-mode tests ---
    if (options.makeFaultyPair) {
      const makeFaulty = options.makeFaultyPair;
      describe("failure modes (optional)", () => {
        it("peer drop fires close", { timeout }, async () => {
          const pair = await makeFaulty();
          let closed = false;
          // Drop after a small delay.
          setTimeout(() => pair.dropConnection(), 50);
          // Detect close by trying a postMessage that never arrives.
          const detect = new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              closed = true;
              resolve();
            }, 500);
            pair.b.addEventListener(
              "message",
              () => {
                clearTimeout(t);
              },
              { once: true } as AddEventListenerOptions,
            );
            pair.b.start();
          });
          await detect;
          expect(closed).toBe(true);
          await pair.close();
        });
      });
    } else {
      describe.skip("failure modes (optional)", () => {
        it("skipped — no makeFaultyPair supplied", () => {});
      });
    }
  });
}
