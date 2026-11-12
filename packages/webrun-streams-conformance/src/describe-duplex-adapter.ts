import { collectBytes, type Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import type { MakePair } from "./loopback.js";

export interface DescribeDuplexAdapterOptions {
  /** Number of concurrent calls for L1. Default 10. */
  concurrency?: number;
  /** Bypass the 10 MiB L0 case (some transports rate-limit). Default false. */
  skipHugeBody?: boolean;
}

/**
 * Runs every conformance level (L0–L6) against the supplied `ConnectServePair`
 * factory. Each adapter package in the `webrun-streams-*` family invokes this
 * from its own one-line Vitest file.
 */
export function describeDuplexAdapter(
  name: string,
  makePair: MakePair,
  opts: DescribeDuplexAdapterOptions = {},
): void {
  const concurrency = opts.concurrency ?? 10;

  describe(`${name} — Duplex conformance`, () => {
    describe("L0: envelope round-trip", () => {
      const cases: Array<{ label: string; size: number }> = [
        { label: "empty", size: 0 },
        { label: "1 KiB", size: 1024 },
        { label: "1 MiB", size: 1024 * 1024 },
      ];
      if (!opts.skipHugeBody) cases.push({ label: "10 MiB", size: 10 * 1024 * 1024 });

      for (const { label, size } of cases) {
        it(`round-trips ${label} body via echo handler`, async () => {
          const pair = await makePair();
          try {
            await pair.serve(echoHandler);
            const { call, close } = await pair.connect();
            try {
              const input = randomBytes(size);
              const out = call([input]);
              const received = await collectBytes(out);
              expect(received.byteLength).toBe(size);
              expect(bytesEqual(received, input)).toBe(true);
            } finally {
              await close();
            }
          } finally {
            await pair.close();
          }
        });
      }
    });

    describe("L1: concurrent calls", () => {
      it(`completes ${concurrency} concurrent calls with correct per-call bodies`, async () => {
        const pair = await makePair();
        try {
          await pair.serve(echoHandler);
          const { call, close } = await pair.connect();
          try {
            const calls = Array.from({ length: concurrency }, async (_, i) => {
              const body = new TextEncoder().encode(`body-${i}-${"x".repeat(64)}`);
              const out = call([body]);
              const received = await collectBytes(out);
              return { i, received, body };
            });
            const results = await Promise.all(calls);
            for (const { i, received, body } of results) {
              expect(received.byteLength, `call ${i}`).toBe(body.byteLength);
              expect(bytesEqual(received, body), `call ${i}`).toBe(true);
            }
          } finally {
            await close();
          }
        } finally {
          await pair.close();
        }
      });
    });

    describe("L2: half-close", () => {
      it("response continues yielding after input exhausts", async () => {
        const pair = await makePair();
        try {
          await pair.serve(async function* lateResponder(input) {
            // Drain input.
            for await (const _ of input) {
              /* discard */
            }
            // Then yield over time.
            yield new TextEncoder().encode("a");
            await delay(30);
            yield new TextEncoder().encode("b");
            await delay(30);
            yield new TextEncoder().encode("c");
          });
          const { call, close } = await pair.connect();
          try {
            const out = call(
              (async function* () {
                yield new TextEncoder().encode("ping");
              })(),
            );
            const text = new TextDecoder().decode(await collectBytes(out));
            expect(text).toBe("abc");
          } finally {
            await close();
          }
        } finally {
          await pair.close();
        }
      });
    });

    describe("L3: mid-stream cancellation", () => {
      it("propagates caller .return() to handler", async () => {
        const pair = await makePair();
        try {
          let handlerCleanupRan = false;
          await pair.serve(async function* unboundedResponder() {
            try {
              while (true) {
                yield new TextEncoder().encode("tick");
                await delay(10);
              }
            } finally {
              handlerCleanupRan = true;
            }
          });
          const { call, close } = await pair.connect();
          try {
            const out = call([new Uint8Array(0)]);
            let count = 0;
            for await (const _ of out) {
              count++;
              if (count >= 3) break;
            }
            // Give the handler a moment to observe the cancellation.
            await delay(50);
            expect(count).toBe(3);
            expect(handlerCleanupRan).toBe(true);
          } finally {
            await close();
          }
        } finally {
          await pair.close();
        }
      });
    });

    describe("L4: error propagation", () => {
      it("preserves message, custom fields, and stack across the wire", async () => {
        const pair = await makePair();
        try {
          await pair.serve(async function* failingHandler() {
            const err = new Error("intentional failure");
            Object.assign(err, { status: 418, code: "TEAPOT" });
            if ((0 as number) === 0) throw err;
            yield new Uint8Array(0);
          });
          const { call, close } = await pair.connect();
          try {
            const out = call([new Uint8Array(0)]);
            await expect(async () => {
              for await (const _ of out) {
                /* drain */
              }
            }).rejects.toMatchObject({
              message: "intentional failure",
              status: 418,
              code: "TEAPOT",
            });
            // Stack must be a non-empty string (modulo loopback returning the
            // same Error instance, native bridges reconstructing it).
            try {
              for await (const _ of call([new Uint8Array(0)])) {
                /* drain */
              }
            } catch (caught) {
              expect(typeof (caught as Error).stack).toBe("string");
              expect(((caught as Error).stack ?? "").length).toBeGreaterThan(0);
            }
          } finally {
            await close();
          }
        } finally {
          await pair.close();
        }
      });
    });

    describe("L5: transport teardown", () => {
      it("idempotent serve teardown", async () => {
        const pair = await makePair();
        try {
          const teardown = await pair.serve(echoHandler);
          await teardown();
          await expect(teardown()).resolves.toBeUndefined();
        } finally {
          await pair.close();
        }
      });

      it("pair close after operation completes without throwing", async () => {
        const pair = await makePair();
        await pair.serve(echoHandler);
        const { call, close } = await pair.connect();
        const out = call([new TextEncoder().encode("x")]);
        await collectBytes(out);
        await close();
        await expect(pair.close()).resolves.toBeUndefined();
      });
    });

    describe("L6: flow control", () => {
      it("delivers a 256 KiB body, crossing as many messages, to a slow consumer", async () => {
        const pair = await makePair({ maxMessageSize: 4096 });
        try {
          await pair.serve(echoHandler);
          const size = 256 * 1024;
          const body = new Uint8Array(size);
          for (let i = 0; i < size; i++) body[i] = i & 0xff;
          const { call, close } = await pair.connect();
          const received: Uint8Array[] = [];
          for await (const chunk of call([body])) {
            received.push(chunk);
            await delay(1);
          }
          expect(bytesEqual(concat(received), body)).toBe(true);
          await close();
        } finally {
          await pair.close();
        }
      });

      for (const direction of ["response", "request"] as const) {
        it(`a ${direction} producer stops within the pair's runAheadBytes of a consumer that stopped reading, and finishes when it resumes`, async () => {
          const pair = await makePair();
          const bound = pair.runAheadBytes;
          const CHUNK = 4096;
          // Enough to exceed the bound twice over, so an unbounded transport
          // shows; a pair without a bound gets a 1 MiB body.
          const count =
            bound === undefined ? 256 : Math.max(64, Math.ceil((2 * bound + 64 * 1024) / CHUNK));
          let produced = 0;
          const producer = async function* () {
            for (let i = 0; i < count; i++) {
              produced++;
              yield new Uint8Array(CHUNK).fill(i & 0xff);
            }
          };
          /** Waits until `produced` stops growing: the producer has stalled or finished. */
          const settled = async () => {
            let last = -1;
            for (let i = 0; i < 40 && produced !== last; i++) {
              last = produced;
              await delay(100);
            }
          };
          const check = (consumedBytes: number) => {
            const ahead = produced * CHUNK - consumedBytes;
            if (bound !== undefined) expect(ahead).toBeLessThanOrEqual(bound);
          };
          try {
            if (direction === "response") {
              await pair.serve(async function* (input) {
                for await (const _ of input);
                yield* producer();
              });
              const { call, close } = await pair.connect();
              const it = call([])[Symbol.asyncIterator]();
              const chunks: Uint8Array[] = [(await it.next()).value as Uint8Array];
              await settled();
              check(chunks[0]?.byteLength ?? 0);
              for (let r = await it.next(); !r.done; r = await it.next()) chunks.push(r.value);
              const all = concat(chunks);
              expect(all.byteLength).toBe(count * CHUNK);
              expect(all[all.byteLength - 1]).toBe((count - 1) & 0xff);
              await close();
            } else {
              let handlerConsumed = 0;
              let resume!: () => void;
              const gate = new Promise<void>((r) => {
                resume = r;
              });
              await pair.serve(async function* (input) {
                let first = true;
                let last = -1;
                for await (const chunk of input) {
                  handlerConsumed += chunk.byteLength;
                  last = chunk[chunk.byteLength - 1] as number;
                  if (first) {
                    first = false;
                    yield new Uint8Array([1]); // tell the caller the first chunk arrived
                    await gate;
                  }
                }
                yield new TextEncoder().encode(`${handlerConsumed}:${last}`);
              });
              const { call, close } = await pair.connect();
              const it = call(producer())[Symbol.asyncIterator]();
              await it.next(); // the first chunk reached the handler
              await settled();
              check(handlerConsumed);
              resume();
              const rest: Uint8Array[] = [];
              for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
              expect(new TextDecoder().decode(concat(rest))).toBe(
                `${count * CHUNK}:${(count - 1) & 0xff}`,
              );
              await close();
            }
          } finally {
            await pair.close();
          }
        }, 60_000);
      }
    });
  });
}

const echoHandler: Duplex = async function* echo(input) {
  for await (const chunk of input) yield chunk;
};

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  // Cheap deterministic-but-non-trivial fill — full crypto.getRandomValues is
  // capped at 64 KiB per call in browsers, and conformance just needs the
  // bytes to round-trip, not be cryptographically random.
  for (let i = 0; i < size; i++) out[i] = (i * 2654435761) & 0xff;
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
