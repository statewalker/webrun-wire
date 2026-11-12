import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { messageTargetOverWebSocket, openWebSocket } from "../src/message-target.js";
import type { WebSocketLike } from "../src/websocket-like.js";

const NodeCtor = NodeWebSocket as unknown as new (
  u: string,
  p?: string | string[],
) => WebSocketLike;

/**
 * The port stack over a WebSocket: each socket is one pipe of bytes
 * (`messageTargetOverWebSocket`), `overPipe` with `msgpackCodec` invents the
 * ports, and `webrun-rpc`'s `connect` / `serve` run one call per port.
 *
 * `PairTuning` is ignored, as on every port-stack pair: under spec D11 there is
 * no credit window to shrink, so L6 here is an integrity check only. Flow
 * control on this stack is covered by `webrun-rpc`'s own backpressure tests.
 */
export const makeWsPortPair: MakePair = async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("WS server has no address");
  const url = `ws://127.0.0.1:${address.port}`;
  return {
    async connect() {
      const ws = await openWebSocket({ url, WebSocketCtor: NodeCtor });
      const { target, signal } = messageTargetOverWebSocket(ws);
      return connect({ mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal }) });
    },
    async serve(handler) {
      const teardowns = new Set<() => Promise<void>>();
      const onConn = (socket: NodeWebSocket): void => {
        socket.binaryType = "nodebuffer";
        const { target, signal } = messageTargetOverWebSocket(socket as unknown as WebSocketLike);
        void serve(
          { mux: overPipe(target, { codec: msgpackCodec, side: "responder", signal }) },
          handler,
        ).then((teardown) => {
          teardowns.add(teardown);
          signal.addEventListener("abort", () => teardowns.delete(teardown), { once: true });
        });
      };
      wss.on("connection", onConn);
      return async () => {
        wss.off("connection", onConn);
        for (const teardown of [...teardowns]) await teardown();
      };
    },
    async close() {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
        for (const c of wss.clients) c.terminate();
      });
    },
  };
};
