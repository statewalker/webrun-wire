import type { MessagePipe } from "@statewalker/webrun-streams";

/**
 * Relays bytes both ways between two pipes, without decoding them: the
 * content script between the page's `messagePortPipe` and the service
 * worker's `chromePortPipe`. When either pipe ends, the other is closed with
 * the same reason, so the far end learns why (a page sees "the
 * chrome.runtime.Port disconnected" when the service worker stops).
 *
 * Returns a function that stops the relay and closes both pipes.
 */
export function relayPipes(a: MessagePipe, b: MessagePipe): (reason?: unknown) => Promise<void> {
  const forward =
    (to: MessagePipe) =>
    (event: MessageEvent): void => {
      try {
        to.target.postMessage(event.data);
      } catch {
        // A frame past `to`'s ceiling ended `to`: its end closes the other side.
      }
    };
  const aToB = forward(b);
  const bToA = forward(a);
  a.target.addEventListener("message", aToB);
  b.target.addEventListener("message", bToA);

  const onAEnd = (): void => {
    void b.target.close(a.signal.reason);
  };
  const onBEnd = (): void => {
    void a.target.close(b.signal.reason);
  };
  const stopLinking = (): void => {
    a.signal.removeEventListener("abort", onAEnd);
    b.signal.removeEventListener("abort", onBEnd);
  };
  if (a.signal.aborted) onAEnd();
  else a.signal.addEventListener("abort", onAEnd, { once: true });
  if (b.signal.aborted) onBEnd();
  else b.signal.addEventListener("abort", onBEnd, { once: true });

  return async (reason?: unknown) => {
    stopLinking();
    a.target.removeEventListener("message", aToB);
    b.target.removeEventListener("message", bToA);
    await Promise.all([a.target.close(reason), b.target.close(reason)]);
  };
}
