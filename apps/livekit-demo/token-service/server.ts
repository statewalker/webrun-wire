import { createServer } from "node:http";
import { AccessToken } from "livekit-server-sdk";

const PORT = Number(process.env.TOKEN_SERVICE_PORT ?? 9091);
// LiveKit dev-mode hard-codes these. For production, inject via env vars and
// never expose to the browser.
const API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? "secret";

const server = createServer(async (req, res) => {
  // CORS for the browser dev servers (5275 + 5276).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/token") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const identity = url.searchParams.get("identity");
  const roomName = url.searchParams.get("room");
  if (!identity || !roomName) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("missing ?identity= and/or ?room=");
    return;
  }

  try {
    const at = new AccessToken(API_KEY, API_SECRET, { identity });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    const body = JSON.stringify({
      token,
      url: process.env.LIVEKIT_URL ?? "ws://localhost:7880",
      identity,
      room: roomName,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    console.log(`[token-service] issued ${identity}@${roomName}`);
  } catch (err) {
    console.error("[token-service] error:", err);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error: ${(err as Error).message}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[token-service] listening on http://127.0.0.1:${PORT}/token`);
  console.log(`[token-service] api key: ${API_KEY} (dev mode)`);
});

const shutdown = (signal: string): void => {
  console.log(`\n[token-service] received ${signal}, stopping...`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
