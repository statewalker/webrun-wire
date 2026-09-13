/**
 * When a CALLER cancels, the SERVER'S HANDLER must unwind.
 *
 * The other direction from `cancel-open-input.test.ts`, and the one a mesh
 * depends on: a handler that streams for ever (a subscription, a tail, a chat)
 * must stop when the peer walks away, or every abandoned call leaves a
 * generator running on the serving side.
 *
 * `serveConnections` builds `duplexOverStream(stream, handlerOutput)`, so on
 * the serving side the "input" IS the handler's own generator. Cancelling it
 * is therefore the same mechanism as cancelling a caller's producer — which is
 * why both directions live in this package's tests rather than in a consumer's.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeLibp2pPair } from "./make-libp2p-pair.js";

const te = new TextEncoder();

describe("duplexOverStream: a caller's cancellation unwinds the server's handler", () => {
  let pair: Awaited<ReturnType<typeof makeLibp2pPair>>;
  let stopServing: () => Promise<void>;
  const state = { unwound: false };

  beforeAll(async () => {
    pair = await makeLibp2pPair();
    stopServing = await pair.serve(async function* () {
      // Streams for ever, and records whether it was ever told to stop.
      try {
        for (;;) {
          yield te.encode("tick");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        state.unwound = true;
      }
    });
  }, 60_000);

  afterAll(async () => {
    await stopServing?.();
    await pair?.close();
  });

  it("runs the handler's finally when the caller returns early", async () => {
    const connection = await pair.connect();

    // An input that ends immediately: the caller has nothing to say, it just
    // listens — the commonest shape for a subscription.
    const nothing = (async function* (): AsyncGenerator<Uint8Array> {})();

    let taken = 0;
    for await (const _chunk of connection.call(nothing)) {
      void _chunk;
      taken += 1;
      if (taken >= 3) break; // `break` calls `.return()` on the generator
    }
    expect(taken).toBe(3);

    const deadline = Date.now() + 10_000;
    while (!state.unwound && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state.unwound).toBe(true);

    await connection.close();
  }, 30_000);
});
