import { type Duplex, emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromWebSocket } from "./byte-channel.js";
import type { WebSocketLike } from "./websocket-like.js";

export interface ServeWsParams {
  /**
   * Source of inbound WebSocket connections. Either a `wss` instance with a
   * `connection` event, or a manual handler the caller wires to its own
   * server.
   */
  onConnection: (cb: (ws: WebSocketLike) => void) => () => void;
}

/**
 * Register a `Duplex` handler against an inbound-WebSocket source. The
 * `onConnection` callback is invoked once per accepted connection; the
 * adapter wraps each in `emulateMux` and binds the handler.
 *
 * Returns an idempotent teardown that unregisters the connection listener.
 * Open `emulateMux` instances continue running until their underlying
 * WebSocket closes.
 */
export async function serve(params: ServeWsParams, handler: Duplex): Promise<() => Promise<void>> {
  const off = params.onConnection((ws) => {
    const channel = byteChannelFromWebSocket(ws);
    const mux = emulateMux(channel, { side: "responder" });
    mux.serve(handler);
    void channel.closed.then(() => mux.close());
  });
  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    off();
  };
}
