/// <reference types="vite/client" />
import { peerIdFromString } from "@libp2p/peer-id";
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

const GROUP_ID = location.hash.slice(1) || import.meta.env.VITE_GROUP_ID || "default";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`client-page: missing ${sel}`);
  return el;
};

const groupIdEl = $<HTMLElement>("#group-id");
const peerIdEl = $<HTMLElement>("#peer-id");
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

function shortPeer(peerId: string): string {
  return `${peerId.slice(0, 12)}…`;
}

/**
 * Prefer the `/webrtc` entry — that's the WebRTC-upgradable form; libp2p
 * dials through the relay then upgrades to a direct browser-to-browser
 * connection. Falls back to whatever the peer advertised first.
 */
function pickDialAddr(multiaddrs: string[]): string | undefined {
  return multiaddrs.find((m) => m.includes("/webrtc")) ?? multiaddrs[0];
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

  // peerStore is the primary source — it's populated by pubsub-peer-discovery
  // and any peer info libp2p has learned through identify / other paths.
  let multiaddrs: string[] = [];
  try {
    const peer = await node.peerStore.get(peerIdFromString(peerId));
    multiaddrs = peer.addresses.map((a) => a.multiaddr.toString());
  } catch {
    /* not in peerStore yet — fall through to the constructed form */
  }

  // Always append the relay → circuit → webrtc form. The library broadcasts
  // whatever node.getMultiaddrs() returns at the moment, which can be empty
  // or local-only on the server before its circuit-relay reservation lands.
  // Constructing the form ourselves from the (always-known) relay multiaddr
  // gives a guaranteed-dialable address; it's the same shape the pre-refactor
  // demo used unconditionally.
  multiaddrs.push(`${relayMultiaddr}/p2p-circuit/webrtc/p2p/${peerId}`);

  const addr = pickDialAddr(multiaddrs);
  if (!addr) return undefined;
  setStatus(`dialing ${shortPeer(peerId)} via ${addr.slice(0, 64)}…`);
  const handle = await connectLibp2p({
    node,
    peer: multiaddr(addr),
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
  setStatus(`mount ${service.id} from ${shortPeer(peerId)}`);

  const site = await new HostedSiteBuilder()
    .setSiteKey(`p2p-${peerId.slice(0, 12)}-${service.id}`)
    .setHandler(async (req) => {
      // Look up the current handle on every request so a peer that evicts
      // and rejoins (same peerId) transparently reconnects on the next fetch.
      const h = await getOrOpenHandle(peerId).catch((err) => {
        setStatus(`reconnect to ${shortPeer(peerId)} failed: ${(err as Error).message}`);
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
  peerLabel.textContent = shortPeer(peerId);

  const badge = document.createElement("span");
  badge.className = "badge-connected";
  badge.textContent = "● connected";

  header.append(title, peerLabel, badge);

  const iframe = document.createElement("iframe");
  iframe.className = "mount-iframe";
  iframe.title = `${service.title} from ${shortPeer(peerId)}`;
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
  setStatus(`unmount ${serviceId} from ${shortPeer(peerId)}`);
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
    peerLabel.className = "svc-peer";
    peerLabel.textContent = shortPeer(row.peerId);

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
  peerIdEl.textContent = selfPeerId;

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
