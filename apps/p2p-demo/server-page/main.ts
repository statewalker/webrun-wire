/// <reference types="vite/client" />
import { multiaddr } from "@multiformats/multiaddr";
import { serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import {
  serve as serveLibp2p,
  DEFAULT_PROTOCOL as WEBRUN_STREAMS_LIBP2P_PROTOCOL,
} from "@statewalker/webrun-streams-libp2p";
import type { HttpService, PeerEntry } from "../lib/announcement.js";
import { createBrowserLibp2pNode, readRelayMultiaddr } from "../lib/browser-node.js";
import { joinGroup } from "../lib/join-group.js";

const GROUP_ID = location.hash.slice(1) || import.meta.env.VITE_GROUP_ID || "default";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`server-page: missing ${sel}`);
  return el;
};

const groupIdEl = $<HTMLElement>("#group-id");
const peerIdEl = $<HTMLElement>("#peer-id");
const statusStateEl = $<HTMLElement>("#status-state");
const statusEl = $<HTMLDivElement>("#status");
const myServicesEl = $<HTMLUListElement>("#my-services");
const peersEl = $<HTMLUListElement>("#peers");

groupIdEl.textContent = GROUP_ID;

function setStatus(line: string): void {
  const t = new Date().toISOString().slice(11, 19);
  statusEl.textContent = `[${t}] ${line}\n${statusEl.textContent ?? ""}`.slice(0, 4000);
}

function setHeaderState(text: string): void {
  statusStateEl.textContent = text;
}

let nextSseId = 0;
const activeSseStops = new Set<(reason: string) => void>();

const SERVICES: HttpService[] = [
  { id: "main-site", kind: "http", title: "Hello site", path: "/" },
  { id: "news", kind: "http", title: "News feed", path: "/news" },
];

function buildSiteHandler(): SiteHandler {
  const indexHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>p2p site</title></head>
<body>
  <h1>Hello from the p2p server</h1>
  <p>Group: <code>${GROUP_ID}</code></p>
  <p>Current server time: <code id="t">…</code></p>
  <p><a href="news">/news</a></p>
  <script>
    fetch("api/time").then((r) => r.json()).then((j) => {
      document.getElementById("t").textContent = j.now;
    }).catch((err) => {
      document.getElementById("t").textContent = "error: " + err.message;
    });
  </script>
</body></html>`;

  const newsHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>news</title></head>
<body>
  <h1>News feed</h1>
  <p>Group: <code>${GROUP_ID}</code></p>
  <ul>
    <li>Server peer is online.</li>
    <li>Auto-discovery via gossipsub on topic <code>webrun/${GROUP_ID}/announce</code>.</li>
    <li>This page is the second service announced by the server.</li>
  </ul>
</body></html>`;

  return new SiteBuilder()
    .setEndpoint("/", "GET", () =>
      Promise.resolve(
        new Response(indexHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    )
    .setEndpoint("/news", "GET", () =>
      Promise.resolve(
        new Response(newsHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
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
        const message = `SSE #${sseId} stopped after ${i} ticks (${reason})`;
        setStatus(message);
        if (controllerRef) {
          try {
            controllerRef.close();
          } catch {
            /* already closed */
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
          setStatus(`SSE #${sseId} started`);
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

function renderMyServices(): void {
  if (SERVICES.length === 0) {
    myServicesEl.innerHTML = "<li>(none)</li>";
    return;
  }
  myServicesEl.innerHTML = SERVICES.map(
    (s) =>
      `<li><strong>${s.id}</strong> — ${s.title} <span class="peer-id">(${s.path ?? "/"})</span></li>`,
  ).join("");
}

function ageSecs(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return `${s}s ago`;
}

function renderPeers(state: ReadonlyMap<string, PeerEntry>): void {
  const entries = [...state.entries()];
  if (entries.length === 0) {
    peersEl.innerHTML = "<li>(no peers yet)</li>";
    return;
  }
  peersEl.innerHTML = entries
    .map(([peerId, entry]) => {
      const id = `${peerId.slice(0, 16)}…`;
      const role =
        entry.services.length > 0
          ? `<span class="role-server">server</span>`
          : `<span class="role-client">client</span>`;
      const count = entry.services.length;
      const label = `${count} service${count === 1 ? "" : "s"}`;
      return `<li><span class="peer-id">${id}</span> · ${role} · (${label}) · ${ageSecs(entry.lastSeen)}</li>`;
    })
    .join("");
}

async function start(): Promise<void> {
  let relayMultiaddr: string;
  try {
    relayMultiaddr = readRelayMultiaddr();
  } catch (err) {
    setStatus((err as Error).message);
    setHeaderState("failed");
    return;
  }
  setStatus(`group: ${GROUP_ID}`);
  setStatus(`using relay: ${relayMultiaddr}`);
  setStatus("creating browser libp2p node");

  const node = await createBrowserLibp2pNode({
    listen: ["/webrtc", "/p2p-circuit"],
    groupId: GROUP_ID,
  });

  peerIdEl.textContent = node.peerId.toString();

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

  const stopServing = await serveLibp2p(
    { node, protocol: WEBRUN_STREAMS_LIBP2P_PROTOCOL },
    serveFetchOverDuplex(async (req) => handler(req)),
  );
  void stopServing;

  const drainSseStops = (reason: string): void => {
    if (activeSseStops.size === 0) return;
    const stops = [...activeSseStops];
    activeSseStops.clear();
    for (const sseStop of stops) {
      try {
        sseStop(reason);
      } catch {
        /* ignore */
      }
    }
  };

  node.addEventListener("connection:open", (evt) => {
    setStatus(`connection:open → ${evt.detail.remotePeer.toString().slice(0, 12)}…`);
  });
  node.addEventListener("connection:close", (evt) => {
    drainSseStops(`connection:close ${evt.detail.id}`);
    setStatus(`connection:close → ${evt.detail.remotePeer.toString().slice(0, 12)}…`);
  });

  setStatus("dialing relay");
  try {
    await node.dial(multiaddr(relayMultiaddr));
    setStatus("dialed relay; awaiting circuit reservation");
    setHeaderState("connected");
  } catch (err) {
    setStatus(`relay dial failed: ${(err as Error).message}`);
    setHeaderState("relay unreachable");
    throw err;
  }

  // Join the group and announce both services. Render the live peers list.
  const group = await joinGroup({ node, groupId: GROUP_ID });
  for (const svc of SERVICES) group.announceService(svc);
  renderMyServices();
  renderPeers(group.state);
  group.on("change", renderPeers);
  // Re-render the age column once per second even when nothing changes.
  setInterval(() => renderPeers(group.state), 1000);
}

void start().catch((err) => {
  console.error(err);
  setStatus(`fatal: ${(err as Error).message}`);
  setHeaderState("fatal");
});
