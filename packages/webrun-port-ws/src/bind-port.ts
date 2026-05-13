import { type WebSocketLike, WS_READY_STATE } from "./websocket-like.js";

/**
 * Bridge a `WebSocket` to a *caller-supplied* `MessagePort`. Anything written
 * to the port is shipped over the socket (JSON-stringified if not binary), and
 * anything arriving on the socket is surfaced as a `message` event on the port
 * (JSON-parsed if text).
 *
 * This entry point predates {@link createWebSocketPort} (which returns a fresh
 * port whose peer half lives behind the bridge) and is retained for callers
 * that need to attach to an existing `MessagePort` they obtained elsewhere.
 *
 * Returns a cleanup function that detaches listeners and closes both ends.
 * Assumes the socket is already `OPEN`; use {@link waitForWebSocketOpen} first
 * if the caller holds a still-connecting socket.
 */
export function bindWebSocketToPort(ws: WebSocketLike, port: MessagePort): () => void {
  let closed = false;

  const onSocketMessage = (event: MessageEvent) => {
    if (closed) return;
    const data = event.data as unknown;
    if (typeof data === "string") {
      try {
        port.postMessage(JSON.parse(data));
      } catch {
        port.postMessage(data);
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      port.postMessage(data, [data]);
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then((buffer) => {
        if (!closed) port.postMessage(buffer, [buffer]);
      });
      return;
    }
    port.postMessage(data);
  };

  const onPortMessage = (event: MessageEvent) => {
    if (closed) return;
    if (ws.readyState !== WS_READY_STATE.OPEN) return;
    const data = event.data as unknown;
    if (data instanceof ArrayBuffer || (typeof Blob !== "undefined" && data instanceof Blob)) {
      ws.send(data as ArrayBuffer | Blob);
    } else {
      ws.send(JSON.stringify(data));
    }
  };

  const onSocketClose = () => {
    if (!closed) cleanup();
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    ws.removeEventListener("message", onSocketMessage);
    ws.removeEventListener("close", onSocketClose);
    port.removeEventListener("message", onPortMessage);
    if (ws.readyState === WS_READY_STATE.OPEN || ws.readyState === WS_READY_STATE.CONNECTING) {
      ws.close();
    }
    port.close();
  };

  ws.addEventListener("message", onSocketMessage);
  ws.addEventListener("close", onSocketClose);
  port.addEventListener("message", onPortMessage);
  if (typeof port.start === "function") port.start();

  return cleanup;
}
