/// <reference types="vite/client" />
import { multiaddr } from "@multiformats/multiaddr";
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { type HostedSite, HostedSiteBuilder } from "@statewalker/webrun-site-host";
import type { Duplex } from "@statewalker/webrun-streams";
import {
  connect as connectLibp2p,
  DEFAULT_PROTOCOL as WEBRUN_STREAMS_LIBP2P_PROTOCOL,
} from "@statewalker/webrun-streams-libp2p";
import type { HttpService } from "../lib/announcement.js";
import { createBrowserLibp2pNode, readRelayMultiaddr } from "../lib/browser-node.js";
import { type GroupHandle, joinGroup } from "../lib/join-group.js";
import { ensureSynth, onSynthCacheUpdate, synthOf } from "../lib/peer-id-synth.js";

const GROUP_ID = location.hash.slice(1) || import.meta.env.VITE_GROUP_ID || "default";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`client-page: missing ${sel}`);
  return el;
};

const groupIdEl = $<HTMLElement>("#group-id");
const peerIdEl = $<HTMLElement>("#peer-id");
const pageSynthEl = $<HTMLElement>("#page-synth");
const statusStateEl = $<HTMLElement>("#status-state");
const statusEl = $<HTMLDivElement>("#status");
const servicesEl = $<HTMLUListElement>("#services");
const mountsEl = $<HTMLDivElement>("#mounts");

groupIdEl.textContent = GROUP_ID;

function setStatus(line: string): void {
  const t = new Date().toISOString().slice(11, 19);
  statusEl.textContent = `[${t}] ${line}\n${statusEl.textContent ?? ""}`.slice(0, 4000);
}

function setHeaderState(text: string): void {
  statusStateEl.textContent = text;
}

interface CallHandle {
  call: Duplex;
  close(): Promise<void>;
}

interface MountedEntry {
  service: HttpService;
  card: HTMLDivElement;
  iframe: HTMLIFrameElement;
  badge: HTMLSpanElement;
  site: HostedSite;
}

const handles = new Map<string, CallHandle>();
/** Key: `<peerId>:<serviceId>`. */
const mounted = new Map<string, MountedEntry>();

let group: GroupHandle | undefined;

function mountKey(peerId: string, serviceId: string): string {
  return `${peerId}:${serviceId}`;
}

async function getOrOpenHandle(peerId: string): Promise<CallHandle | undefined> {
  const existing = handles.get(peerId);
  if (existing) return existing;

  // Construct the dial address from the known relay multiaddr. We do NOT
  // use peerStore multiaddrs because:
  //   1. pubsub-peer-discovery broadcasts whatever node.getMultiaddrs()
  //      returns at the moment, which can be local-only / non-/webrtc
  //      before the server's circuit-relay reservation lands.
  //   2. libp2p's auto-dial (triggered by pubsub-peer-discovery) may have
  //      already opened a *limited* relay-only connection using a non-
  //      /webrtc form. Custom protocols cannot ride on a limited
  //      connection ("Cannot open protocol stream on limited connection").
  //
  // The /webrtc segment between /p2p-circuit and /p2p/<peer> tells libp2p
  // to upgrade to a direct browser-to-browser WebRTC connection. Doing the
  // dial ourselves with this exact form guarantees the upgrade.
  const peerMa = multiaddr(`${relayMultiaddr}/p2p-circuit/webrtc/p2p/${peerId}`);
  setStatus(`dialing ${synthOf(peerId)} (relay → WebRTC)…`);
  try {
    const connection = await node.dial(peerMa);
    setStatus(`dialed ${synthOf(peerId)} (limited=${connection.limits != null})`);
  } catch (err) {
    setStatus(`dial to ${synthOf(peerId)} failed: ${(err as Error).message}`);
    throw err;
  }

  const handle = await connectLibp2p({
    node,
    peer: peerMa,
    protocol: WEBRUN_STREAMS_LIBP2P_PROTOCOL,
  });
  handles.set(peerId, handle);
  return handle;
}

async function closeHandle(peerId: string): Promise<void> {
  const handle = handles.get(peerId);
  if (!handle) return;
  handles.delete(peerId);
  try {
    await handle.close();
  } catch {
    /* best-effort */
  }
}

async function mountService(peerId: string, service: HttpService): Promise<void> {
  const key = mountKey(peerId, service.id);
  if (mounted.has(key)) return;
  setStatus(`mount ${service.id} from ${synthOf(peerId)}`);

  const site = await new HostedSiteBuilder()
    .setSiteKey(`p2p-${peerId.slice(0, 12)}-${service.id}`)
    .setHandler(async (req) => {
      // Look up the current handle on every request so a peer that evicts
      // and rejoins (same peerId) transparently reconnects on the next fetch.
      const h = await getOrOpenHandle(peerId).catch((err) => {
        setStatus(`reconnect to ${synthOf(peerId)} failed: ${(err as Error).message}`);
        return undefined;
      });
      if (!h) {
        return new Response("peer disconnected", { status: 503 });
      }
      return fetchOverDuplex(h.call, req);
    })
    .build();

  const card = document.createElement("div");
  card.className = "mount-card";

  const header = document.createElement("div");
  header.className = "mount-header";

  const title = document.createElement("strong");
  title.textContent = service.title;

  const peerLabel = document.createElement("span");
  peerLabel.className = "svc-peer";
  peerLabel.textContent = synthOf(peerId);

  const badge = document.createElement("span");
  badge.className = "badge-connected";
  badge.textContent = "● connected";

  header.append(title, peerLabel, badge);

  const iframe = document.createElement("iframe");
  iframe.className = "mount-iframe";
  iframe.title = `${service.title} from ${synthOf(peerId)}`;
  iframe.src = site.baseUrl + (service.path ?? "/");

  card.append(header, iframe);
  mountsEl.append(card);

  mounted.set(key, { service, card, iframe, badge, site });
  rerender();
}

async function unmountService(peerId: string, serviceId: string): Promise<void> {
  const key = mountKey(peerId, serviceId);
  const entry = mounted.get(key);
  if (!entry) return;
  setStatus(`unmount ${serviceId} from ${synthOf(peerId)}`);
  entry.card.remove();
  try {
    await entry.site.stop();
  } catch {
    /* best-effort */
  }
  mounted.delete(key);

  // If this was the peer's last mount, drop the cached connection.
  const stillUsed = [...mounted.keys()].some((k) => k.startsWith(`${peerId}:`));
  if (!stillUsed) await closeHandle(peerId);
  rerender();
}

/**
 * Render the Services list from the union of currently-announced services
 * (from group state) and currently-mounted services (which may include
 * ghost rows for peers that evicted while a mount remains).
 */
function rerender(): void {
  if (!group) return;
  // Kick off synth computation for every known peer. Fire-and-forget; the
  // onSynthCacheUpdate subscription below triggers a re-render when results
  // land, so the row gets the real id without us blocking the first paint.
  for (const peerId of group.state.keys()) void ensureSynth(peerId);

  type Row = {
    peerId: string;
    service: HttpService;
    state: "available" | "mounted" | "disconnected";
  };
  const rows: Row[] = [];

  // Announced services (in state).
  for (const [peerId, entry] of group.state) {
    if (peerId === selfPeerId) continue;
    for (const svc of entry.services) {
      if (svc.kind !== "http") continue;
      const isMounted = mounted.has(mountKey(peerId, svc.id));
      rows.push({ peerId, service: svc, state: isMounted ? "mounted" : "available" });
    }
  }
  // Ghost rows: mounted entries whose peer is no longer in state.
  // Also refresh each card's connection badge to reflect liveness.
  for (const [key, entry] of mounted) {
    const mPeerId = key.slice(0, key.indexOf(":"));
    const peerInState = group.state.has(mPeerId);
    if (!peerInState) {
      rows.push({ peerId: mPeerId, service: entry.service, state: "disconnected" });
    }
    entry.badge.textContent = peerInState ? "● connected" : "○ disconnected";
    entry.badge.className = peerInState ? "badge-connected" : "badge-disconnected";
    if (peerInState) {
      entry.iframe.classList.remove("mount-iframe-dimmed");
    } else {
      entry.iframe.classList.add("mount-iframe-dimmed");
    }
  }

  if (rows.length === 0) {
    servicesEl.innerHTML = "<li class='svc-row'>(no services yet)</li>";
    return;
  }
  // Stable order: peerId then serviceId.
  rows.sort((a, b) =>
    a.peerId === b.peerId
      ? a.service.id.localeCompare(b.service.id)
      : a.peerId.localeCompare(b.peerId),
  );

  servicesEl.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "svc-row";

    const title = document.createElement("span");
    title.className = "svc-title";
    title.textContent = row.service.title;

    const peerLabel = document.createElement("span");
    peerLabel.className = "svc-from";
    peerLabel.innerHTML = `from <code title="${row.peerId}">${synthOf(row.peerId)}</code> <span class="role-badge role-badge-server">SERVER</span>`;

    const stateSpan = document.createElement("span");
    stateSpan.className = `svc-state-${row.state}`;
    stateSpan.textContent = row.state;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = row.state === "available" ? "Mount" : "Unmount";
    button.addEventListener("click", () => {
      if (row.state === "available") {
        void mountService(row.peerId, row.service).catch((err) => {
          setStatus(`mount failed: ${(err as Error).message}`);
        });
      } else {
        void unmountService(row.peerId, row.service.id);
      }
    });

    li.append(title, peerLabel, stateSpan, button);
    servicesEl.append(li);
  }
}

let node!: Awaited<ReturnType<typeof createBrowserLibp2pNode>>;
let selfPeerId = "";
let relayMultiaddr = "";

async function start(): Promise<void> {
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

  node = await createBrowserLibp2pNode({ listen: ["/webrtc"], groupId: GROUP_ID });
  selfPeerId = node.peerId.toString();
  const selfSynth = await ensureSynth(selfPeerId);
  peerIdEl.textContent = selfSynth;
  peerIdEl.title = selfPeerId;
  pageSynthEl.textContent = selfSynth;
  pageSynthEl.title = selfPeerId;
  document.title = `Client: ${selfSynth} · p2p-demo`;

  setStatus(`dialing relay: ${relayMultiaddr.slice(0, 60)}…`);
  try {
    await node.dial(multiaddr(relayMultiaddr));
    setStatus("dialed relay; joining group");
    setHeaderState("connected");
  } catch (err) {
    setStatus(`relay dial failed: ${(err as Error).message}`);
    setHeaderState("relay unreachable");
    throw err;
  }

  group = await joinGroup({ node, groupId: GROUP_ID });
  group.on("change", () => {
    // Reconcile: peers that left the state drop their cached handle. The
    // iframe stays mounted as a ghost row until the user unmounts.
    for (const peerId of [...handles.keys()]) {
      if (!group?.state.has(peerId)) void closeHandle(peerId);
    }
    rerender();
  });
  rerender();
  // Re-render once a second so age/state badges stay fresh even when nothing
  // structural changes.
  setInterval(rerender, 1000);
  // Re-render whenever a new peer's synth id lands in the cache (SHA-1 is
  // async; the first paint shows the placeholder and gets replaced here).
  onSynthCacheUpdate(rerender);

  Object.assign(globalThis as unknown as { __p2p: unknown }, {
    __p2p: {
      node,
      group: () => group,
      mounted: () => mounted,
      handles: () => handles,
    },
  });
}

void start().catch((err) => {
  console.error(err);
  setStatus(`fatal: ${(err as Error).message}`);
  setHeaderState("fatal");
});
