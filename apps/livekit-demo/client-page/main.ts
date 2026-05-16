import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import type { Duplex } from "@statewalker/webrun-streams";
import { connect as connectLiveKit } from "@statewalker/webrun-streams-livekit";
import { type RemoteParticipant, type Room, RoomEvent } from "livekit-client";
import { DEMO_ROOM, SERVER_IDENTITY } from "../lib/config.js";
import { connectLiveKitRoom } from "../lib/livekit-room.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`client-page: missing ${sel}`);
  return el;
};

const identityEl = $<HTMLElement>("#identity");
const roomEl = $<HTMLElement>("#room");
const statusEl = $<HTMLDivElement>("#status");
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

// A unique identity per client tab so multiple clients can coexist in the
// same room without collision.
const CLIENT_IDENTITY = `site-client-${crypto.randomUUID().slice(0, 8)}`;

function waitForServerPeer(room: Room, identity: string): Promise<RemoteParticipant> {
  for (const p of room.remoteParticipants.values()) {
    if (p.identity === identity) return Promise.resolve(p);
  }
  return new Promise((resolve) => {
    const onConnect = (p: RemoteParticipant): void => {
      if (p.identity !== identity) return;
      room.off(RoomEvent.ParticipantConnected, onConnect);
      resolve(p);
    };
    room.on(RoomEvent.ParticipantConnected, onConnect);
  });
}

/**
 * Probe the remote peer until a request actually returns a response. Needed
 * because LiveKit's `participantConnected` event on the server side can lag
 * 1-2 s behind the client's "joined room" state, so a fetch fired at that
 * moment hits the SFU before the server has registered its `dataReceived`
 * listener and is silently dropped (livekit-client's event emitter has no
 * buffering). Retries with a short per-attempt timeout until a round-trip
 * actually succeeds.
 */
async function waitForRemoteHandler(call: Duplex, log: (msg: string) => void): Promise<void> {
  const PER_ATTEMPT_TIMEOUT = 1000;
  const MAX_ATTEMPTS = 15;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT);
    try {
      const res = await fetchOverDuplex(
        call,
        new Request("http://x/api/time", { signal: ctrl.signal }),
      );
      clearTimeout(timer);
      if (res.ok) {
        // Drain the body so the response stream actually completes; otherwise
        // the underlying Duplex sub-stream stays half-open.
        await res.arrayBuffer();
        log(`handshake ok on attempt ${attempt}`);
        return;
      }
      log(`handshake attempt ${attempt} returned status ${res.status}, retrying`);
    } catch (err) {
      clearTimeout(timer);
      const name = (err as Error).name;
      log(
        `handshake attempt ${attempt} ${name === "AbortError" ? "timed out" : `failed (${name})`}, retrying`,
      );
    }
  }
  throw new Error(`handshake failed after ${MAX_ATTEMPTS} attempts`);
}

async function start(): Promise<void> {
  identityEl.textContent = CLIENT_IDENTITY;
  roomEl.textContent = DEMO_ROOM;

  setStatus(`connecting as ${CLIENT_IDENTITY}`);
  let room: Room;
  try {
    room = await connectLiveKitRoom(CLIENT_IDENTITY, DEMO_ROOM);
  } catch (err) {
    setStatus(`connect failed: ${(err as Error).message}`);
    throw err;
  }
  setStatus(`joined room ${DEMO_ROOM}`);

  setStatus(`waiting for server participant ${SERVER_IDENTITY}`);
  const serverParticipant = await waitForServerPeer(room, SERVER_IDENTITY);
  setStatus(`server participant present (sid:${serverParticipant.sid})`);

  const { call: activeCall } = await connectLiveKit({
    room,
    peerIdentity: SERVER_IDENTITY,
  });

  // Handshake before mounting the site. The server's `participantConnected`
  // event can fire 1-2 s after our `joined room` state, so a request fired
  // immediately is sent before its `dataReceived` listener exists and is
  // silently dropped. Retry a cheap round-trip until one actually returns.
  setStatus("handshaking with server peer");
  await waitForRemoteHandler(activeCall, setStatus);

  // Include the per-tab client identity in the site key so each page load
  // gets its own SW route under `/<this-tab's-key>/`. With a fixed key,
  // reloading the tab leaves a stale entry in the SW's clientId-keyed handler
  // index; Firefox keeps that stale Client object "alive" long enough that
  // the SW routes the fresh iframe's request to the dead Duplex and the
  // iframe hangs forever. Per-tab keys sidestep the lookup entirely.
  const site = await new HostedSiteBuilder()
    .setSiteKey(`livekit-${CLIENT_IDENTITY}`)
    .setHandler((req) => fetchOverDuplex(activeCall, req))
    .build();

  setStatus(`site mounted at ${site.baseUrl}`);
  previewIframe.src = `${site.baseUrl}`;

  sseStartBtn.disabled = false;
  sseStopBtn.disabled = true;

  // React to the server peer leaving the room. Without a graceful
  // `room.disconnect()` (see `pagehide` below), LiveKit's keepalive
  // timeout is what surfaces this event — usually within 10-30 s of the
  // server's tab actually closing.
  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    if (p.identity !== SERVER_IDENTITY) return;
    setStatus(`server peer ${p.identity} disconnected — reload to reconnect`);
    sseStartBtn.disabled = true;
    sseStopBtn.disabled = true;
    if (sseController) sseController.abort();
    previewIframe.src = "about:blank";
  });

  // Gracefully leave the room when the tab is being closed/reloaded so the
  // surviving peer is notified immediately rather than after LiveKit's
  // keepalive timeout. `pagehide` is the canonical "page is going away"
  // event — fires for both reload and navigation, unlike `beforeunload`
  // which is suppressed by some bfcache transitions.
  addEventListener("pagehide", () => {
    void room.disconnect();
  });

  let sseController: AbortController | null = null;

  sseStartBtn.addEventListener("click", async () => {
    setStatus("subscribe clicked");
    sseStartBtn.disabled = true;
    sseStopBtn.disabled = false;
    sseLogEl.innerHTML = "";
    const ctrl = new AbortController();
    sseController = ctrl;
    try {
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
  Object.assign(globalThis as unknown as { __livekit: unknown }, {
    __livekit: { room, call: activeCall, site },
  });
}

void start().catch((err) => {
  console.error(err);
  setStatus(`fatal: ${(err as Error).message}`);
});
