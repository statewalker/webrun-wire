import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { fetchOverDuplex, serveFetchOverDuplex } from "../src/fetch.js";
import { httpFetch } from "../src/http-data.js";

/**
 * A caller that stops reading a response releases the handler's producer.
 *
 * The body the codec hands back is a generator over its own `ByteReader`, and
 * `.return()` on it never reached the call: an aborted `fetch` or a cancelled
 * response stream left the producer parked forever. Over a direct loopback the
 * call's generator IS the server's, so its release is the handler's stream
 * being cancelled.
 */

/** An endless response, counting chunks produced and noting its cancellation. */
function endless() {
  const state = { produced: 0, cancelled: false };
  const handler = async () =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            state.produced++;
            controller.enqueue(new Uint8Array(1024));
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  return { state, call: serveFetchOverDuplex(handler) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("leaving a response body early releases the producer", () => {
  it("cancelling the Response's stream", async () => {
    const { state, call } = endless();
    const response = await fetchOverDuplex(call, new Request("http://x/"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await settle();
    expect(state.cancelled).toBe(true);
  });

  it("aborting the request's signal", async () => {
    const { state, call } = endless();
    const controller = new AbortController();
    const response = await fetchOverDuplex(
      call,
      new Request("http://x/", { signal: controller.signal }),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await settle();
    expect(state.cancelled).toBe(true);
  });

  it("breaking out of httpFetch's body", async () => {
    const { state, call } = endless();
    const { body } = await httpFetch(call, { url: "http://x/", method: "GET", headers: [] });
    for await (const _ of body) break;
    await settle();
    expect(state.cancelled).toBe(true);
  });

  it("release() without reading", async () => {
    const { state, call } = endless();
    const { release } = await httpFetch(call, { url: "http://x/", method: "GET", headers: [] });
    await release?.();
    await settle();
    expect(state.cancelled).toBe(true);
  });
});

// In Node, a Request's signal follows the caller's signal only while the Request lives (undici
// holds the Request's controller through a WeakRef). A caller that keeps only the Response must
// still be able to abort: these tests let the Request go and force a GC before aborting.
describe("an abort after the caller has let the Request go", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const collect = async () => {
    await settle();
    gc();
    gc();
    await settle();
  };

  it("ends an unread body and releases the producer", async () => {
    const { state, call } = endless();
    const controller = new AbortController();
    // The Request lives only inside this function.
    const response = await (async () =>
      fetchOverDuplex(call, new Request("http://x/", { signal: controller.signal })))();
    await collect();
    controller.abort(new Error("gave up"));
    await settle();
    expect(state.cancelled).toBe(true);
    await expect(response.text()).rejects.toThrow("gave up");
  });

  /**
   * A call whose peer sends the whole response and then never ends the call. The pending read
   * is reachable from `state`, as a transport's listener keeps it (a port's `onmessage`): what
   * the call holds stays alive through it, and nothing else of the test holds the Request.
   */
  function neverEnding(inner: Duplex) {
    const state: {
      released: boolean;
      wake?: (r: IteratorResult<Uint8Array>) => void;
    } = { released: false };
    const call: Duplex = (input) => {
      const it = inner(input);
      return {
        async next() {
          const r = await it.next();
          if (!r.done) return r;
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            state.wake = resolve;
          });
        },
        async return() {
          state.released = true;
          state.wake?.({ done: true, value: undefined });
          return { done: true, value: undefined } as IteratorResult<Uint8Array>;
        },
        async throw(error: unknown) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      } as unknown as AsyncGenerator<Uint8Array>;
    };
    return { call, state };
  }

  for (const method of ["GET", "HEAD"]) {
    it(`${method}: abandons a call the peer never ends, after the body is taken`, async () => {
      const { call, state } = neverEnding(serveFetchOverDuplex(async () => new Response("hello")));
      const controller = new AbortController();
      const response = await (async () =>
        fetchOverDuplex(call, new Request("http://x/", { method, signal: controller.signal })))();
      await response.text();
      await collect();
      controller.abort(new Error("gave up"));
      await settle();
      expect(state.released).toBe(true);
    });
  }
});
