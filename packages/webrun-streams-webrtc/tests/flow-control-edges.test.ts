import { describe, expect, it } from "vitest";

// Flow control must not deadlock where a call does not stream both ways: browser only.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

const MiB = 1024 * 1024;

async function* source(n: number, state = { pulled: 0, finalized: false }) {
  try {
    for (let sent = 0; sent < n; sent += 65536) {
      state.pulled += 65536;
      yield new Uint8Array(65536);
    }
  } finally {
    state.finalized = true;
  }
}
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms),
    ),
  ]);
async function drain(g: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of g) n += c.byteLength;
  return n;
}

if (isBrowser) {
  const { makeWebRtcPair } = await import("./make-webrtc-pair.js");

  describe("webrun-streams-webrtc — flow control without deadlocks", () => {
    it("a reply larger than the window, sent after the whole input was read", async () => {
      const pair = await makeWebRtcPair();
      try {
        await pair.serve(async function* (input) {
          const parts: Uint8Array[] = [];
          for await (const c of input) parts.push(c);
          yield* parts;
        });
        const { call } = await pair.connect();
        expect(await within(drain(call(source(10 * MiB))), 20_000, "echo")).toBe(10 * MiB);
      } finally {
        await pair.close();
      }
    }, 30_000);

    it("a reply larger than the window, sent before reading any input", async () => {
      const pair = await makeWebRtcPair();
      try {
        await pair.serve(async function* (input) {
          for (let i = 0; i < 160; i++) yield new Uint8Array(65536);
          for await (const _ of input) {
            /* read afterwards */
          }
        });
        const { call } = await pair.connect();
        expect(await within(drain(call(source(10 * MiB))), 20_000, "reply first")).toBe(10 * MiB);
      } finally {
        await pair.close();
      }
    }, 30_000);

    it("a handler that throws without reading: the caller gets the error while its upload is stalled", async () => {
      const pair = await makeWebRtcPair();
      try {
        await pair.serve(async function* (_input) {
          yield* [];
          throw new Error("boom");
        });
        const { call } = await pair.connect();
        await expect(within(drain(call(source(10 * MiB))), 10_000, "error")).rejects.toThrow(
          "boom",
        );
      } finally {
        await pair.close();
      }
    }, 30_000);

    it("a handler that answers without reading its body: the caller's upload is finished, not leaked", async () => {
      const pair = await makeWebRtcPair();
      const state = { pulled: 0, finalized: false };
      try {
        await pair.serve(async function* (_input) {
          yield new Uint8Array([1]);
        });
        const { call } = await pair.connect();
        expect(await within(drain(call(source(10 * MiB, state))), 10_000, "reply")).toBe(1);
        await within(
          (async () => {
            while (!state.finalized) await new Promise((r) => setTimeout(r, 50));
          })(),
          20_000, // in-page SCTP can stall for seconds on a retransmit; the point is that it ends
          "upload finalized",
        );
      } finally {
        await pair.close();
      }
    }, 45_000);

    it("cancelling a call whose upload is stalled returns promptly", async () => {
      const pair = await makeWebRtcPair();
      try {
        await pair.serve(async function* (_input) {
          for (;;) {
            yield new Uint8Array(1024);
            await new Promise((r) => setTimeout(r, 10));
          }
        });
        const { call } = await pair.connect();
        const g = call(source(20 * MiB));
        await g.next();
        await new Promise((r) => setTimeout(r, 1500));
        await within(g.return(undefined), 5_000, "return()");
      } finally {
        await pair.close();
      }
    }, 30_000);
  });
} else {
  describe.skip("webrun-streams-webrtc flow-control edges (browser only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
