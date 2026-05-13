import { WebSocketServer } from "ws";

/**
 * Browser-mode globalSetup: starts a relay WebSocketServer that connects pairs
 * of clients by room ID. A browser-side `makeWsPair` opens two `WebSocket`s
 * with the same `?room=<id>` query, and this server pipes bytes between them.
 *
 * The server URL is exposed via the `WEBRUN_PORT_WS_RELAY_URL` env var.
 *
 * Node-mode tests use `make-ws-pair.ts` which spins a one-shot server per
 * pair and does not need this relay.
 */
export default async function setup() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WS server has no address");
  const url = `ws://127.0.0.1:${address.port}`;

  type Room = { a?: WebSocket; b?: WebSocket };
  const rooms = new Map<string, Room>();

  server.on("connection", (ws, request) => {
    const params = new URLSearchParams((request.url ?? "").split("?")[1] ?? "");
    const id = params.get("room");
    if (!id) {
      ws.close(1003, "missing ?room");
      return;
    }
    let room = rooms.get(id);
    if (!room) {
      room = {};
      rooms.set(id, room);
    }
    const peerKey: "a" | "b" = room.a ? "b" : "a";
    room[peerKey] = ws as unknown as WebSocket;
    ws.on("message", (data) => {
      const other = peerKey === "a" ? room.b : room.a;
      if (other && (other as unknown as { readyState: number }).readyState === 1) {
        (other as unknown as { send: (d: unknown) => void }).send(data);
      }
    });
    ws.on("close", () => {
      const other = peerKey === "a" ? room.b : room.a;
      try {
        other?.close();
      } catch {}
      rooms.delete(id);
    });
  });

  process.env.WEBRUN_PORT_WS_RELAY_URL = url;

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
