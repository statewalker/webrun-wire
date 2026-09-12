/**
 * When a caller aborts, the handler on the other side of the port must stop.
 *
 * This is the browser's commonest leak, reproduced here with two plain
 * `MessagePort`s and no ServiceWorker: a page registers a handler through
 * `handleHttpRequests`; the worker calls it through `sendHttpRequest`; the
 * browser cancels the response body because the user navigated away or an
 * `AbortController` fired. Measured in a real Chromium (httpeers rung 14), the
 * worker IS told — the `ReadableStream` it handed to `respondWith` has its
 * `cancel()` invoked — but nothing carried that across the port, so the
 * handler's producer kept producing for the life of the page.
 *
 * Closing a `MessagePort` does not notify its peer, so the transport needs an
 * explicit cancellation message. These tests pin both halves of it: the
 * cancellation must travel, and a call that ends normally must NOT look like
 * a cancellation.
 */

import { describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/core/message-target.js";
import { handleHttpRequests, sendHttpRequest } from "../src/http/http-send-recieve.js";

function asTarget(port: MessagePort): MessageTarget {
  return port as unknown as MessageTarget;
}

async function waitFor(probe: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not true after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("http over a MessagePort: cancellation reaches the handler", () => {
  it("a cancelled response body unwinds the handler's producer", async () => {
    const state = { ticks: 0, unwound: false };
    const channel = new MessageChannel();

    const stop = handleHttpRequests(asTarget(channel.port1), async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (let n = 0; n < 2_000; n++) {
              controller.enqueue(new TextEncoder().encode(`tick-${n}\n`));
              state.ticks = n + 1;
              // Ticking, not flooding: an unthrottled producer fills the
              // queue instead of parking, and then this would measure the
              // queue rather than the cancellation.
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            controller.close();
          } catch {
            // `enqueue` after cancellation throws; `cancel` is the signal.
          } finally {
            state.unwound = true;
          }
        },
        cancel() {
          state.unwound = true;
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    });

    const response = await sendHttpRequest(
      asTarget(channel.port2),
      new Request("https://site.local/stream"),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();

    // The caller walks away mid-stream — what `AbortController` does to a
    // fetch, and what a browser does when the tab navigates.
    await reader.cancel(new Error("caller went away"));

    await waitFor(() => state.unwound, 5_000, "the handler's producer was never cancelled");
    const ticksAtCancel = state.ticks;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(state.ticks).toBe(ticksAtCancel);

    stop();
    channel.port1.close();
    channel.port2.close();
  }, 20_000);

  it("a call that ends normally still delivers every chunk", async () => {
    // The guard: cancellation must not be inferred from an ordinary ending,
    // or every completed response would look like an abort.
    const state = { cancelled: false };
    const channel = new MessageChannel();

    const stop = handleHttpRequests(asTarget(channel.port1), async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let n = 0; n < 5; n++) {
            controller.enqueue(new TextEncoder().encode(`chunk-${n};`));
          }
          controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    });

    const response = await sendHttpRequest(
      asTarget(channel.port2),
      new Request("https://site.local/short"),
    );
    expect(await response.text()).toBe("chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;");
    expect(state.cancelled).toBe(false);

    stop();
    channel.port1.close();
    channel.port2.close();
  }, 20_000);
});
