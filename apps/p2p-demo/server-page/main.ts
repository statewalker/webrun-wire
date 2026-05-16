import { multiaddr } from "@multiformats/multiaddr";
import { serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import {
  serve as serveLibp2p,
  DEFAULT_PROTOCOL as WEBRUN_STREAMS_LIBP2P_PROTOCOL,
} from "@statewalker/webrun-streams-libp2p";
import type { Libp2p } from "libp2p";
import { createBrowserLibp2pNode, readRelayMultiaddr } from "../lib/browser-node.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`server-page: missing ${sel}`);
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

let nextSseId = 0;

// Tracks every still-running SSE stream so a libp2p stream close (or any
// other transport-level teardown) can force them to stop even when the
// graceful `cancel-channel` chain doesn't reach them (e.g., the consumer
// peer disappeared without posting a cancel).
const activeSseStops = new Set<(reason: string) => void>();

function buildSiteHandler(): SiteHandler {
  // NOTE: the inline script uses the relative path "api/time" (no leading
  // slash) so it resolves against the iframe's full URL
  // (`https://<origin>/<siteKey>/`), keeping the request inside the SW's
  // intercept scope for this site. A leading slash would resolve to
  // `/api/time` — outside the site key, so the SW would fall through to the
  // dev server's SPA fallback and return HTML instead of JSON.
  const indexHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>p2p site</title></head>
<body>
  <h1>Hello from the p2p server</h1>
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
        new Response(indexHtml, {
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

      // Unified teardown. Reached via any of three paths:
      //   1. ReadableStream.cancel() — the graceful path: consumer cancelled,
      //      readableToAsyncIterable's reader.cancel() bubbles up to here.
      //   2. controller.enqueue() throws — the stream was closed/errored from
      //      below the SSE source.
      //   3. The libp2p stream this SSE rode on disappears — invoked via
      //      `activeSseStops` from the connection close watchdog.
      // Whichever fires first wins; the others become no-ops.
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
        console.log("[p2p-demo:server]", message);
        // Best-effort close on the controller — harmless if already closed.
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
          console.log("[p2p-demo:server]", message);

          // Anti-buffering: SSE messages can be batched by intermediate layers
          // (Firefox's fetch ReadableStream queueing, WebRTC SCTP small-message
          // coalescing, libp2p yamux flow control). Two cooperating tricks:
          //
          //   1. Initial 2 KiB padding line — many buffer heuristics flush
          //      once a stream's first byte run exceeds ~2 KB.
          //   2. Heartbeat comment every 500 ms — keeps the stream
          //      continuously active so the lower layers never sit on an
          //      idle queue long enough for batching to feel justified.
          //
          // Comment lines (`:`-prefixed, no `data:`) are silently ignored by
          // both EventSource and our manual parser, so they're free protocol
          // bytes from the application's perspective.
          // enqueue(`:${" ".repeat(2048)}\n\n`);

          tickTimer = setInterval(() => {
            enqueue(`data: ${JSON.stringify({ tick: i++ })}\n\n`);
          }, 1000);
          heartbeatTimer = setInterval(() => {
            enqueue(":keepalive\n\n");
          }, 500);
        },
        cancel(reason) {
          // ReadableStream.cancel propagates the consumer's intent. The cancel
          // reason is whatever the upstream reader.cancel(reason) passed —
          // usually undefined, occasionally an AbortError.
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
  let relayMultiaddr: string;
  try {
    relayMultiaddr = readRelayMultiaddr();
  } catch (err) {
    setStatus((err as Error).message);
    return;
  }
  setStatus(`using relay: ${relayMultiaddr}`);
  setStatus("creating browser libp2p node");

  const node = await createBrowserLibp2pNode({
    listen: ["/webrtc", "/p2p-circuit"],
  });

  const peerIdStr = node.peerId.toString();
  peerIdEl.textContent = peerIdStr;
  copyPeerBtn.disabled = false;
  copyPeerBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(peerIdStr);
  });

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

  // Build the site handler once and host it over libp2p via the Duplex seam.
  // Each inbound libp2p stream carries one HTTP call (yamux multiplexes many
  // concurrent streams over a single peer connection). Connection-level
  // observability comes from libp2p's `connection:open` / `connection:close`
  // events directly; per-stream lifecycle is hidden inside the adapter.
  const stopServing = await serveLibp2p(
    { node, protocol: WEBRUN_STREAMS_LIBP2P_PROTOCOL },
    serveFetchOverDuplex(async (req) => handler(req)),
  );

  // Force-stop any SSE streams when their underlying transport disappears.
  // The graceful cancel chain (request body `reader.cancel` → ReadableStream
  // `cancel()` callback) covers the consumer-cancel case; this covers the
  // abrupt-disconnect case where the libp2p stream dies before the chain
  // can fire.
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
  node.addEventListener("self:peer:update", () => updateAdvertisedAddr(node));
  void stopServing; // retain reference; teardown happens on page unload

  setStatus("dialing relay");
  try {
    await node.dial(multiaddr(relayMultiaddr));
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
