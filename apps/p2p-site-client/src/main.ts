/// <reference types="vite/client" />
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { fetchOverPort } from "@statewalker/webrun-http-port/fetch";
import {
  createLibp2pStreamPort,
  WEBRUN_PORT_LIBP2P_PROTOCOL,
} from "@statewalker/webrun-port-libp2p";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { createLibp2p } from "libp2p";

const RELAY_MULTIADDR =
  import.meta.env.VITE_RELAY_MULTIADDR ??
  "/ip4/127.0.0.1/tcp/9090/ws/p2p/REPLACE_WITH_RELAY_PEER_ID";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`p2p-site-client: missing ${sel}`);
  return el;
};

const statusEl = $<HTMLDivElement>("#status");
const peerInput = $<HTMLInputElement>("#server-peer-id");
const connectBtn = $<HTMLButtonElement>("#connect-btn");
const previewIframe = $<HTMLIFrameElement>("#preview");
const sseStartBtn = $<HTMLButtonElement>("#sse-start");
const sseStopBtn = $<HTMLButtonElement>("#sse-stop");
const sseLogEl = $<HTMLUListElement>("#sse-log");

function setStatus(line: string): void {
  const t = new Date().toISOString().slice(11, 19);
  statusEl.textContent = `[${t}] ${line}\n${statusEl.textContent ?? ""}`.slice(0, 4000);
}

async function start(): Promise<void> {
  setStatus("creating browser libp2p node");
  const node = await createLibp2p({
    addresses: { listen: ["/webrtc"] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });

  setStatus(`dialing relay: ${RELAY_MULTIADDR.slice(0, 60)}…`);
  await node.dial(multiaddr(RELAY_MULTIADDR));
  setStatus("dialed relay; ready to connect to a server peer");
  connectBtn.disabled = false;

  let activePort: MessagePort | null = null;
  let activeSiteUrl: string | null = null;

  connectBtn.addEventListener("click", async () => {
    const serverPeerId = peerInput.value.trim();
    if (!serverPeerId) {
      setStatus("enter a server peer id first");
      return;
    }
    connectBtn.disabled = true;
    try {
      const peerMa = multiaddr(`${RELAY_MULTIADDR}/p2p-circuit/p2p/${serverPeerId}`);
      setStatus(`dialing peer through relay: ${serverPeerId.slice(0, 12)}…`);
      await node.dial(peerMa);

      setStatus(`opening ${WEBRUN_PORT_LIBP2P_PROTOCOL} stream`);
      const stream = await node.dialProtocol(peerMa, WEBRUN_PORT_LIBP2P_PROTOCOL);
      activePort = createLibp2pStreamPort(stream);

      const site = await new HostedSiteBuilder()
        .setSiteKey(`p2p-${serverPeerId.slice(0, 12)}`)
        .setHandler((req) => {
          if (!activePort) return Promise.resolve(new Response("disconnected", { status: 503 }));
          return fetchOverPort(activePort, req);
        })
        .build();

      activeSiteUrl = site.baseUrl;
      setStatus(`site mounted at ${site.baseUrl}`);
      previewIframe.src = `${site.baseUrl}`;

      sseStartBtn.disabled = false;
      sseStopBtn.disabled = true;
    } catch (err) {
      setStatus(`connect failed: ${(err as Error).message}`);
      connectBtn.disabled = false;
    }
  });

  let sseController: AbortController | null = null;
  sseStartBtn.addEventListener("click", async () => {
    if (!activePort) return;
    sseStartBtn.disabled = true;
    sseStopBtn.disabled = false;
    sseLogEl.innerHTML = "";
    const ctrl = new AbortController();
    sseController = ctrl;
    try {
      // Bypass the SW: call directly through the port so the consumer-side
      // cancellation surfaces here. (The SW path is exercised by the iframe.)
      const res = await fetchOverPort(activePort, new Request("http://x/api/events"), {
        signal: ctrl.signal,
      });
      if (!res.body) {
        appendSseLog("(no body)");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (line) appendSseLog(line.slice(5).trim());
            idx = buffer.indexOf("\n\n");
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
      appendSseLog("(closed)");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        appendSseLog("(aborted)");
      } else {
        appendSseLog(`(error: ${(err as Error).message})`);
      }
    } finally {
      sseStartBtn.disabled = false;
      sseStopBtn.disabled = true;
      sseController = null;
    }
  });

  sseStopBtn.addEventListener("click", () => {
    if (sseController) sseController.abort();
  });

  // Expose for console debugging.
  Object.assign(globalThis as unknown as { __p2p: unknown }, {
    __p2p: { node, getActivePort: () => activePort, getSiteUrl: () => activeSiteUrl },
  });
}

function appendSseLog(text: string): void {
  const li = document.createElement("li");
  li.textContent = text;
  sseLogEl.appendChild(li);
  sseLogEl.scrollTop = sseLogEl.scrollHeight;
}

void start().catch((err) => {
  console.error(err);
  setStatus(`fatal: ${(err as Error).message}`);
});
