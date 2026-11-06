import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { fetchOverDuplex, serveFetchOverDuplex } from "../src/fetch.js";

/**
 * The served `Request` carries a `signal` that aborts when the caller abandons
 * the exchange, so a handler that waits before it answers (a long poll) learns
 * its caller left instead of holding on for nothing.
 *
 * A transport tells the handler's side through `return()` on the handler's
 * output, called without waiting — which on an async generator still parked in
 * `await handler(request)` would otherwise be queued until it answers.
 */

/** A handler that waits for its request's signal, as a long poll would. */
function longPoll() {
  const seen: { signal?: AbortSignal } = {};
  const server = serveFetchOverDuplex(async (request) => {
    seen.signal = request.signal;
    await new Promise((resolve) => request.signal.addEventListener("abort", resolve));
    return new Response("too late");
  });
  // Keeps the server's output, as a transport holds it.
  let output: AsyncGenerator<Uint8Array> | undefined;
  const call: Duplex = (input) => {
    output = server(input);
    return output;
  };
  return { seen, call, output: () => output };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("the served Request's signal", () => {
  it("aborts when the transport abandons the exchange while the handler waits", async () => {
    const { seen, call, output } = longPoll();
    void fetchOverDuplex(call, new Request("http://x/poll")).catch(() => {});
    await until(() => seen.signal != null);
    void output()?.return(undefined); // as a transport does: not awaited
    await until(() => seen.signal?.aborted === true);
    expect(String((seen.signal?.reason as Error | undefined)?.message)).toContain("abandoned");
  });

  it("aborts when the caller's own fetch is aborted before the answer", async () => {
    const { seen, call } = longPoll();
    const controller = new AbortController();
    const pending = fetchOverDuplex(
      call,
      new Request("http://x/poll", { signal: controller.signal }),
    ).catch(() => "aborted");
    await until(() => seen.signal != null);
    controller.abort();
    await until(() => seen.signal?.aborted === true);
    expect(await pending).toBe("aborted");
  });

  it("never aborts on an exchange that completed, nor on a return() after it", async () => {
    let signal: AbortSignal | undefined;
    let output: AsyncGenerator<Uint8Array> | undefined;
    const server = serveFetchOverDuplex(async (request) => {
      signal = request.signal;
      return new Response("hello");
    });
    const call: Duplex = (input) => {
      output = server(input);
      return output;
    };
    const response = await fetchOverDuplex(call, new Request("http://x/"));
    expect(await response.text()).toBe("hello");
    await output?.return(undefined);
    expect(signal?.aborted).toBe(false);
  });
});
