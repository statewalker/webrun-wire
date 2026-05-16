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
 * Runs every conformance level (L0–L5) against the supplied `ConnectServePair`
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
