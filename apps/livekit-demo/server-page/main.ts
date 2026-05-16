import { serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import { serve as serveLiveKit } from "@statewalker/webrun-streams-livekit";
import type { RemoteParticipant, Room } from "livekit-client";
import { DEMO_ROOM, SERVER_IDENTITY } from "../lib/config.js";
import { connectLiveKitRoom } from "../lib/livekit-room.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`server-page: missing ${sel}`);
  return el;
};

const roomEl = $<HTMLElement>("#room");
const statusEl = $<HTMLDivElement>("#status");

function setStatus(line: string): void {
  const t = new Date().toISOString().slice(11, 19);
  statusEl.textContent = `[${t}] ${line}\n${statusEl.textContent ?? ""}`.slice(0, 4000);
}

let nextSseId = 0;
const activeSseStops = new Set<(reason: string) => void>();

function buildSiteHandler(): SiteHandler {
  const indexHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>livekit site</title></head>
<body>
  <h1>Hello from the LiveKit server</h1>
  <p>Current server time: <code id="t">…</code></p>
  <script>
    fetch("api/time").then((r) => r.json()).then((j) => {
      document.getElementById("t").textContent = j.now;
    }).catch((err) => {
      document.getElementById("t").textContent = "error: " + err.message;
    });
  </script>
</body></html>`;

  return new SiteBuilder()
    .setEndpoint("/", "GET", () =>
      Promise.resolve(
        new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    )
    .setEndpoint("/api/time", "GET", () =>
      Promise.resolve(
        new Response(JSON.stringify({ now: new Date().toISOString() }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    .setEndpoint("/api/events", "GET", () => {
      const sseId = ++nextSseId;
      const encoder = new TextEncoder();
      let tickTimer: ReturnType<typeof setInterval> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let i = 0;
      let stopped = false;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

      const stop = (reason: string): void => {
        if (stopped) return;
        stopped = true;
        if (tickTimer) clearInterval(tickTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        tickTimer = null;
        heartbeatTimer = null;
        activeSseStops.delete(stop);
        const message = `SSE #${sseId} stopped streaming after ${i} ticks (${reason})`;
        setStatus(message);
        console.log("[livekit-demo:server]", message);
        if (controllerRef) {
          try {
            controllerRef.close();
          } catch {
            /* already closed/errored */
          }
        }
      };

      const enqueue = (text: string): void => {
        if (stopped || !controllerRef) return;
        try {
          controllerRef.enqueue(encoder.encode(text));
        } catch (err) {
          stop(`enqueue threw: ${(err as Error).message}`);
        }
      };

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          activeSseStops.add(stop);
          const message = `SSE #${sseId} started streaming /api/events`;
          setStatus(message);
          console.log("[livekit-demo:server]", message);
          tickTimer = setInterval(() => {
            enqueue(`data: ${JSON.stringify({ tick: i++ })}\n\n`);
          }, 1000);
          heartbeatTimer = setInterval(() => {
            enqueue(":keepalive\n\n");
          }, 500);
        },
        cancel(reason) {
          const tag =
            reason === undefined ? "consumer cancel" : `consumer cancel: ${String(reason)}`;
          stop(tag);
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    })
    .build();
}

async function start(): Promise<void> {
  setStatus("connecting to LiveKit room");
  let room: Room;
  try {
    room = await connectLiveKitRoom(SERVER_IDENTITY, DEMO_ROOM);
  } catch (err) {
    setStatus(`connect failed: ${(err as Error).message}`);
    throw err;
  }
  roomEl.textContent = DEMO_ROOM;
  setStatus(`joined room ${DEMO_ROOM} as ${SERVER_IDENTITY}`);

  const baseHandler = buildSiteHandler();
  const handler: SiteHandler = async (req) => {
    const url = new URL(req.url);
    setStatus(`req ${req.method} ${url.pathname}`);
    try {
      const res = await baseHandler(req);
      setStatus(`res ${url.pathname} → ${res.status}`);
      return res;
    } catch (err) {
      setStatus(`req ${url.pathname} threw: ${(err as Error).message}`);
      throw err;
    }
  };

  // Map participant identity → teardown so disconnects tear down the
  // hosted Duplex serve + any still-running SSE streams.
  const partStops = new Map<string, () => Promise<void>>();
  const httpHandler = serveFetchOverDuplex(async (req) => handler(req));

  const onParticipantConnected = (p: RemoteParticipant): void => {
    setStatus(`client connected ${p.identity} (sid:${p.sid})`);
    void serveLiveKit({ room, peerIdentity: p.identity }, httpHandler).then((stop) => {
      partStops.set(p.identity, stop);
    });
  };

  const onParticipantDisconnected = (p: RemoteParticipant): void => {
    setStatus(`client disconnected ${p.identity}`);
    const stop = partStops.get(p.identity);
    if (stop) {
      void stop().catch(() => {
        /* ignore */
      });
      partStops.delete(p.identity);
    }
    // Best-effort: stop any SSE streams that may still be running. The new
    // cancellation chain (Duplex teardown → response body cancel) should
    // cover this in normal cases; this is the safety net.
    if (activeSseStops.size > 0) {
      const stops = [...activeSseStops];
      activeSseStops.clear();
      for (const sseStop of stops) {
        try {
          sseStop(`participant ${p.identity} disconnected`);
        } catch {
          /* ignore */
        }
      }
    }
  };

  room.on("participantConnected", onParticipantConnected);
  room.on("participantDisconnected", onParticipantDisconnected);

  // Anyone already in the room when we arrive — typically the client peer
  // that beat us to the connect.
  for (const p of room.remoteParticipants.values()) {
    onParticipantConnected(p);
  }

  setStatus(`waiting for clients (current remoteParticipants: ${room.remoteParticipants.size})`);

  // Gracefully leave the room when the tab is being closed/reloaded so each
  // connected client is notified immediately rather than after LiveKit's
  // keepalive timeout (10-30 s by default).
  addEventListener("pagehide", () => {
    void room.disconnect();
  });

  // Expose for console debugging.
  Object.assign(globalThis as unknown as { __livekit: unknown }, {
    __livekit: { room, partStops },
  });
}

void start().catch((err) => {
  console.error(err);
  setStatus(`fatal: ${(err as Error).message}`);
});
