/// <reference types="vite/client" />
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { PortSiteBuilder } from "@statewalker/webrun-http-port";
import {
  createLibp2pStreamPort,
  WEBRUN_PORT_LIBP2P_PROTOCOL,
} from "@statewalker/webrun-port-libp2p";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import { createLibp2p, type Libp2p } from "libp2p";

// Paste the multiaddr printed by `apps/p2p-relay`'s `pnpm start` here.
// Includes the relay's peer id (e.g. `/ip4/127.0.0.1/tcp/9090/ws/p2p/<peerId>`).
const RELAY_MULTIADDR =
  import.meta.env.VITE_RELAY_MULTIADDR ??
  "/ip4/127.0.0.1/tcp/9090/ws/p2p/REPLACE_WITH_RELAY_PEER_ID";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`p2p-site-server: missing ${sel}`);
  return el;
};

const peerIdEl = $<HTMLElement>("#peer-id");
const dialAddrEl = $<HTMLElement>("#dial-addr");
const statusEl = $<HTMLDivElement>("#status");
const copyPeerBtn = $<HTMLButtonElement>("#copy-peer-id");
const copyDialBtn = $<HTMLButtonElement>("#copy-dial-addr");

function setStatus(line: string): void {
  const t = new Date().toISOString().slice(11, 19);
  statusEl.textContent = `[${t}] ${line}\n${statusEl.textContent ?? ""}`.slice(0, 4000);
}

function buildSiteHandler(): SiteHandler {
  const indexHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>p2p site</title></head>
<body>
  <h1>Hello from the p2p server</h1>
  <p>Current server time: <code id="t">…</code></p>
  <script>
    fetch("/api/time").then((r) => r.json()).then((j) => {
      document.getElementById("t").textContent = j.now;
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
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | null = null;
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ tick: i++ })}\n\n`));
            } catch {
              if (timer) clearInterval(timer);
              timer = null;
            }
          }, 1000);
        },
        cancel() {
          if (timer) clearInterval(timer);
          timer = null;
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

function updateAdvertisedAddr(node: Libp2p): void {
  const peerIdStr = node.peerId.toString();
  const addrs = node
    .getMultiaddrs()
    .map((m) => m.toString())
    .filter((s) => s.includes("/p2p-circuit/") || s.includes("/webrtc"));
  const dial = addrs[0] ?? `/p2p/${peerIdStr}`;
  dialAddrEl.textContent = dial;
  copyDialBtn.disabled = false;
  copyDialBtn.onclick = () => {
    void navigator.clipboard.writeText(dial);
  };
}

async function start(): Promise<void> {
  setStatus("creating browser libp2p node");

  const node = await createLibp2p({
    addresses: { listen: ["/webrtc", "/p2p-circuit"] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });

  const peerIdStr = node.peerId.toString();
  peerIdEl.textContent = peerIdStr;
  copyPeerBtn.disabled = false;
  copyPeerBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(peerIdStr);
  });

  const handler = buildSiteHandler();
  let activeStreams = 0;
  await node.handle(WEBRUN_PORT_LIBP2P_PROTOCOL, ({ stream }) => {
    activeStreams++;
    setStatus(`accepted libp2p stream (active: ${activeStreams})`);
    const port = createLibp2pStreamPort(stream);
    const stop = new PortSiteBuilder(port).setHandler(handler).start();
    const closeOnce = (): void => {
      try {
        stop();
      } catch {
        /* ignore */
      }
      activeStreams = Math.max(0, activeStreams - 1);
      setStatus(`libp2p stream closed (active: ${activeStreams})`);
    };
    // Best-effort close detection: poll the stream's status.
    const watchdog = setInterval(() => {
      const status = (stream as unknown as { status?: string }).status;
      if (status === "closed" || status === "aborted" || status === "reset") {
        clearInterval(watchdog);
        closeOnce();
      }
    }, 5000);
  });

  node.addEventListener("connection:open", (evt) => {
    setStatus(`connection:open → ${evt.detail.remotePeer.toString().slice(0, 12)}…`);
  });
  node.addEventListener("connection:close", (evt) => {
    setStatus(`connection:close → ${evt.detail.remotePeer.toString().slice(0, 12)}…`);
  });
  node.addEventListener("self:peer:update", () => updateAdvertisedAddr(node));

  setStatus("dialing relay");
  try {
    await node.dial(multiaddr(RELAY_MULTIADDR));
    setStatus("dialed relay; awaiting circuit reservation");
  } catch (err) {
    setStatus(`relay dial failed: ${(err as Error).message}`);
    throw err;
  }
}

void start().catch((err) => {
  console.error(err);
  setStatus(`fatal: ${(err as Error).message}`);
});
