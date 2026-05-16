import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { connect } from "../src/connect.js";
import { serve } from "../src/serve.js";
import type { WebSocketLike } from "../src/websocket-like.js";

/**
 * Spin up an in-process WebSocket server and connect a client to it. Returns
 * a `ConnectServePair` the conformance suite can drive.
 *
 * Each `pair` corresponds to one client↔server connection. `serve` registers
 * a handler on the server-side WebSocket; `connect` returns the caller-side
 * Duplex over the client-side WebSocket.
 */
export const makeWsPair: MakePair = async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("WS server has no address");
  const url = `ws://127.0.0.1:${address.port}`;

  // We hook onConnection BEFORE the client connects to ensure the inbound
  // socket is captured. Server-side serve waits for connections; client-side
  // connect opens the URL.
  return {
    connect: async () => {
      // The client opens a WS to the server. Use Node's `ws` constructor.
      return connect({
        url,
        WebSocketCtor: NodeWebSocket as unknown as new (
          u: string,
          p?: string | string[],
        ) => WebSocketLike,
      });
    },
    serve: async (handler) => {
      const teardown = await serve(
        {
          onConnection: (cb) => {
            const onConn = (ws: NodeWebSocket): void => {
              ws.binaryType = "nodebuffer";
              cb(ws as unknown as WebSocketLike);
            };
            wss.on("connection", onConn);
            return () => wss.off("connection", onConn);
          },
        },
        handler,
      );
      return teardown;
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
        // Force-close any sockets the server is still tracking so close() doesn't hang.
        for (const c of wss.clients) {
          try {
            c.terminate();
          } catch {
            /* ignore */
          }
        }
      });
    },
  };
};
