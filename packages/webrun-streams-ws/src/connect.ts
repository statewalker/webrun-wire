import { type Connect, type EmulateMuxOptions, emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromWebSocket } from "./byte-channel.js";
import { openWebSocket } from "./message-target.js";
import type { WebSocketLike } from "./websocket-like.js";

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
  /**
   * Flow-control tuning forwarded to `emulateMux` — `mtu` and
   * `maxStreamBuffer`, which is the credit this side advertises. `side` here
   * wins over `mux.side`. Defaults are `emulateMux`'s own; the conformance
   * suite's L6 uses this to run at a window small enough that a sender
   * genuinely stalls.
   */
  mux?: EmulateMuxOptions;
}

/**
 * Open a WebSocket to `params.url`, wrap it as a `ByteChannel`, and run it
 * through `emulateMux`. Returns `{ call, close }` where `call` is the
 * caller-side `Duplex`.
 */
export const connect: Connect<ConnectWsParams> = async (params) => {
  const ws = await openWebSocket(params);
  const channel = byteChannelFromWebSocket(ws);
  const mux = emulateMux(channel, { ...params.mux, side: "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};
