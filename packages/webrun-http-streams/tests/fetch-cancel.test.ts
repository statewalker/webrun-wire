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
    await release();
    await settle();
    expect(state.cancelled).toBe(true);
  });
});
