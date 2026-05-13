import type { MakePair, PortPair } from "@statewalker/webrun-port-conformance";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { createWebSocketPort } from "../src/index.js";
import type { WebSocketLike } from "../src/websocket-like.js";

/**
 * Adapt a Node `ws` WebSocket into the WebSocketLike shape expected by the
 * adapter. Node `ws` already exposes addEventListener/removeEventListener and
 * send/close/readyState, but binary messages arrive as `Buffer` whereas the
 * browser would deliver `ArrayBuffer`. We normalise that here.
 */
function asWebSocketLike(ws: NodeWebSocket): WebSocketLike {
  ws.binaryType = "nodebuffer";
  return ws as unknown as WebSocketLike;
}

export const makeWsPair: MakePair = async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WS server has no address");
  const url = `ws://127.0.0.1:${address.port}`;

  const incoming = new Promise<NodeWebSocket>((resolve) => {
    server.once("connection", (ws) => resolve(ws));
  });

  const clientRaw = new NodeWebSocket(url);
  await new Promise<void>((resolve, reject) => {
    clientRaw.once("open", () => resolve());
    clientRaw.once("error", (err) => reject(err));
  });
  const serverRaw = await incoming;

  const a = createWebSocketPort(asWebSocketLike(clientRaw));
  const b = createWebSocketPort(asWebSocketLike(serverRaw));

  const pair: PortPair = {
    a,
    b,
    async close() {
      try {
        a.close();
      } catch {}
      try {
        b.close();
      } catch {}
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return pair;
};
