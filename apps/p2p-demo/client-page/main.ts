import { multiaddr } from "@multiformats/multiaddr";
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import type { Duplex } from "@statewalker/webrun-streams";
import {
  connect as connectLibp2p,
  DEFAULT_PROTOCOL as WEBRUN_STREAMS_LIBP2P_PROTOCOL,
} from "@statewalker/webrun-streams-libp2p";
import { createBrowserLibp2pNode, readRelayMultiaddr } from "../lib/browser-node.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`client-page: missing ${sel}`);
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

function appendSseLog(text: string): void {
  const li = document.createElement("li");
  li.textContent = text;
  sseLogEl.appendChild(li);
  sseLogEl.scrollTop = sseLogEl.scrollHeight;
}

async function start(): Promise<void> {
  let relayMultiaddr: string;
  try {
    relayMultiaddr = readRelayMultiaddr();
  } catch (err) {
    setStatus((err as Error).message);
    return;
  }

  setStatus(`using relay: ${relayMultiaddr}`);
  setStatus("creating browser libp2p node");
  const node = await createBrowserLibp2pNode({ listen: ["/webrtc"] });

  setStatus(`dialing relay: ${relayMultiaddr.slice(0, 60)}…`);
  await node.dial(multiaddr(relayMultiaddr));
  setStatus("dialed relay; ready to connect to a server peer");
  connectBtn.disabled = false;

  let activeCall: Duplex | null = null;
  let activeSiteUrl: string | null = null;

  connectBtn.addEventListener("click", async () => {
    const serverPeerId = peerInput.value.trim();
    if (!serverPeerId) {
      setStatus("enter a server peer id first");
      return;
    }
    connectBtn.disabled = true;
    try {
      // The /webrtc segment between /p2p-circuit and /p2p/<peer> is what
      // signals "handshake over the relay, then upgrade to a direct WebRTC
      // connection". Without it the dial succeeds but yields a *limited*
      // circuit-relay connection, which rejects custom protocols with
      // "Cannot open protocol stream on limited connection".
      const peerMa = multiaddr(`${relayMultiaddr}/p2p-circuit/webrtc/p2p/${serverPeerId}`);
      setStatus(`dialing peer (relay → WebRTC): ${serverPeerId.slice(0, 12)}…`);
      // Eagerly dial so we surface dial failures here (and warm the
      // connection cache libp2p uses for subsequent `dialProtocol` calls).
      const connection = await node.dial(peerMa);
      setStatus(`connected (limited=${connection.limits != null}); arming call factory`);

      const { call } = await connectLibp2p({
        node,
        peer: peerMa,
        protocol: WEBRUN_STREAMS_LIBP2P_PROTOCOL,
      });
      activeCall = call;

      const site = await new HostedSiteBuilder()
        .setSiteKey(`p2p-${serverPeerId.slice(0, 12)}`)
        .setHandler((req) => {
          if (!activeCall) return Promise.resolve(new Response("disconnected", { status: 503 }));
          return fetchOverDuplex(activeCall, req);
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
    setStatus("subscribe clicked");
    if (!activeCall) {
      setStatus("subscribe: no active connection yet");
      return;
    }
    sseStartBtn.disabled = true;
    sseStopBtn.disabled = false;
    sseLogEl.innerHTML = "";
    const ctrl = new AbortController();
    sseController = ctrl;
    try {
      // Bypass the SW: call directly through the Duplex so the consumer-side
      // cancellation surfaces here. (The SW path is exercised by the iframe.)
      setStatus("subscribe: sending /api/events");
      const res = await fetchOverDuplex(
        activeCall,
        new Request("http://x/api/events", { signal: ctrl.signal }),
      );
      setStatus(`subscribe: got response status=${res.status}`);
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
    __p2p: { node, getActiveCall: () => activeCall, getSiteUrl: () => activeSiteUrl },
  });
}

void start().catch((err) => {
  console.error(err);
  setStatus(`fatal: ${(err as Error).message}`);
});
