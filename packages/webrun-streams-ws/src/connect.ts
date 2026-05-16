import { type Connect, emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromWebSocket } from "./byte-channel.js";
import { type WebSocketLike, WS_READY_STATE } from "./websocket-like.js";

export interface ConnectWsParams {
  /** WebSocket URL (`ws://` or `wss://`). */
  url: string;
  /** Optional subprotocol(s) passed to the WebSocket constructor. */
  protocols?: string | string[];
  /**
   * WebSocket constructor. Defaults to the global `WebSocket` when present
   * (browser); pass Node's `ws` package's `WebSocket` in Node.
   */
  WebSocketCtor?: new (
    url: string,
    protocols?: string | string[],
  ) => WebSocketLike;
}

/**
 * Open a WebSocket to `params.url`, wrap it as a `ByteChannel`, and run it
 * through `emulateMux`. Returns `{ call, close }` where `call` is the
 * caller-side `Duplex`.
 */
export const connect: Connect<ConnectWsParams> = async (params) => {
  const Ctor = params.WebSocketCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Ctor) {
    throw new Error(
      "webrun-streams-ws connect: no WebSocket constructor available. Pass `params.WebSocketCtor` (e.g. the `ws` package's WebSocket in Node).",
    );
  }
  const ws = new Ctor(params.url, params.protocols) as WebSocketLike;
  await waitForOpen(ws);
  const channel = byteChannelFromWebSocket(ws);
  const mux = emulateMux(channel, { side: "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};

function waitForOpen(ws: WebSocketLike): Promise<void> {
  if (ws.readyState === WS_READY_STATE.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onCloseEarly);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("WebSocket error before open"));
    };
    const onCloseEarly = (): void => {
      cleanup();
      reject(new Error("WebSocket closed before it opened"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onCloseEarly);
  });
}
