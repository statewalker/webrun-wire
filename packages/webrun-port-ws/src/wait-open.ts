import { type WebSocketLike, WS_READY_STATE } from "./websocket-like.js";

/**
 * Resolves once the WebSocket reaches the `OPEN` state.
 *
 * Rejects with an `Error` if the socket closes/fails before opening, or if
 * `timeout` ms elapse.
 */
export async function waitForWebSocketOpen(ws: WebSocketLike, timeout = 5000): Promise<void> {
  if (ws.readyState === WS_READY_STATE.OPEN) return;
  if (ws.readyState === WS_READY_STATE.CLOSED || ws.readyState === WS_READY_STATE.CLOSING) {
    throw new Error("WebSocket is closed or closing");
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket open timeout"));
    }, timeout);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}
