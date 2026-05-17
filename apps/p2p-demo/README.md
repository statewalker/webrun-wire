# p2p-demo

## What it is

End-to-end demonstration that browser pages, told only that they belong to
the same **group**, find each other on the network, announce what HTTP
resources they offer, and start serving those resources to each other —
**without any peer-id paste step**.

The demo ships two page roles, both of which can run in any number of tabs:

- **Server page** — registers one or more HTTP services on a local
  `SiteHandler`, announces them on the group's services topic.
- **Client page** — discovers every service offered by every server in the
  group, lists them, and mounts each chosen service in its own iframe behind
  a same-origin ServiceWorker. The list is **live**: when a server page
  vanishes, its services disappear from the list within the staleness window,
  and any iframe mounted from it surfaces a clear "disconnected" state.

Discovery uses **two complementary gossipsub topics** per group:

- `webrun/<groupId>/peer-discovery` — owned by
  [`@libp2p/pubsub-peer-discovery`](https://github.com/libp2p/js-libp2p-pubsub-peer-discovery).
  Carries `{peerId, multiaddrs}`. Feeds libp2p's discovery pipeline so the
  connection manager auto-dials peers in the background — by the time the
  user clicks `[Mount]`, the connection is already warm.
- `webrun/<groupId>/services` — owned by this app (`lib/join-group.ts`).
  Carries the capability catalog (`{peerId, services[], ts, leave?}`).
  This is the source of truth for "who is in the group" at the
  application level.

HTTP traffic itself flows peer-to-peer over the existing
`Connect/Serve/Duplex` libp2p adapter from ADR-0004.

The split into two topics is deliberate: it lets the off-the-shelf
discovery library do what it's best at (presence + auto-dial), and
isolates the bespoke service-catalog protocol into one small custom file.
The two-topic shape is the stepping-stone toward a future
`webrun-p2p-mesh` package, where presence and catalog will be the package's
two public surfaces.

## Why it exists

The previous version of this demo required manual peer-id copy-paste between
two browser tabs — a step that does not survive contact with anything beyond
"two tabs on one developer's machine". This iteration removes the copy-paste
entirely by adding gossipsub-based group discovery and service announcement,
so the demo reflects how a deployed mesh would actually behave: peers find
each other through a shared `groupId`, announce what they offer, and
consumers mount services without any out-of-band coordination.

Parts of the discovery/announcement layer (the gossipsub envelope, the
`joinGroup` API, the per-peer call-handle cache) are candidates for later
extraction into a `webrun-p2p-mesh` package. **Extraction is explicitly out
of scope for this iteration** — the goal here is to prove the shape inside
the app, and only then decide what the package boundary looks like.

## How to use

From `apps/p2p-demo/`:

```sh
pnpm start              # boots relay + server-page (5175) + client-page (5176)
```

The launcher injects `VITE_RELAY_MULTIADDR` (relay's multiaddr) and
`VITE_GROUP_ID` (default group) into both pages, then opens them. Each page
joins the default group on load.

The `groupId` resolution chain is:

```
location.hash.slice(1)       // URL fragment, e.g. "#alpha" → "alpha"
  || import.meta.env.VITE_GROUP_ID
  || "default"
```

There is no error state — if nothing is configured, the page joins the group
named `"default"`. This keeps the demo zero-configuration; group isolation
testing is done by explicitly choosing a non-default fragment.

**To exercise group isolation or run multiple groups in parallel**, override
the groupId with a URL fragment:

```
http://localhost:5175/#alpha   ← server page in group "alpha"
http://localhost:5175/#beta    ← another server page in group "beta"
http://localhost:5176/#alpha   ← client page in group "alpha" — sees only alpha's servers
http://localhost:5176/#beta    ← client page in group "beta"  — sees only beta's servers
```

URL fragment is chosen over a query string because it stays purely
client-side (never sent in HTTP requests).

**Both pages always display the active `groupId` and self synthetic id** in
the status header (the H1 reads `Server: ab12-cd34` / `Client: 9f7e-0001`),
plus a `SERVER` / `CLIENT` role badge — there's no way to be unsure which
group a tab is in or what role it plays.

Open additional server-page tabs to add more services to the same group;
client-page tabs see the new services within one announcement interval (≤5s).

### Synthetic peer ids

libp2p peer ids (`12D3KooW…`) are long and visually indistinguishable at a
glance. The demo derives a deterministic 8-hex-char synthetic id from the
first 4 bytes of `SHA-1(peerId)`, formatted as `abcd-1234`. Same peer →
same synth, in every tab. The full peer id stays available in the `title`
attribute (hover for tooltip). All UI surfaces — status header, page H1,
Services list, Peers list, Mounted iframe card headers, and the **HTML
served by the server** (each page's `<title>` and `<h1>` includes the
server's synth) — use the synth so multiple tabs of the same service are
visually distinct.

## Examples

### `joinGroup` — the API every page calls

```ts
type GroupHandle = {
  state: ReadonlyMap<string, PeerEntry>;   // synchronous current view
  on(event: "change", listener: (state: ReadonlyMap<string, PeerEntry>) => void): () => void;
  announceService(svc: Service): void;     // immediate publish + tick continues
  removeService(serviceId: string): void;  // immediate publish without it
  leave(): Promise<void>;                  // sends best-effort "leave" + unsubscribes
};

type PeerEntry = {
  services: Service[];                     // may be empty for consumer-only peers
  lastSeen: number;
  // multiaddrs are looked up from `node.peerStore` at mount time —
  // they're owned by the peer-discovery topic, not by this map.
};

declare function joinGroup(params: {
  node: Libp2p;
  groupId: string;
}): Promise<GroupHandle>;
```

Symmetric: client pages call `joinGroup` and publish with `services: []`.
The protocol has no consumer-only mode.

### Wire shape — the services-topic announcement

Only the services-topic message is custom (see "What it is" for the second
topic, which is the off-the-shelf `pubsub-peer-discovery` protobuf and
isn't reproduced here).

```ts
type ServiceAnnouncement = {
  v: 1;                       // schema version
  peerId: string;             // self
  services: Service[];        // capability catalog; may be empty
  ts: number;                 // unix ms — staleness math on receivers
  leave?: true;               // graceful-shutdown variant
};

type Service = HttpService;   // only kind defined this iteration

type HttpService = {
  id: string;                 // stable per peer (e.g. "main-site")
  kind: "http";               // discriminator
  title: string;              // human label for the UI list
  path?: string;              // URL prefix on the server's SiteHandler; default "/"
};
```

### Server page — register and announce a service

```ts
const GROUP_ID =
  location.hash.slice(1) || import.meta.env.VITE_GROUP_ID || "default";

// createBrowserLibp2pNode registers both `pubsub: gossipsub()` and
// `peerDiscovery: [pubsubPeerDiscovery({topics: [peerDiscoveryTopic(groupId)]})]`
// at node-creation time — pubsub and discovery services can't be added later.
const node = await createBrowserLibp2pNode({ listen: ["/webrtc", "/p2p-circuit"], groupId: GROUP_ID });
const selfSynth = await ensureSynth(node.peerId.toString());
const group = await joinGroup({ node, groupId: GROUP_ID });

// Same SiteHandler shape as today — see ADR-0004. The served HTML embeds
// `selfSynth` in each page's <title>/<h1> so the rendered iframe content
// is self-identifying ("Hello site · ab12-cd34") when multiple servers
// run in the same group.
const handler = new SiteBuilder()
  .setEndpoint("/", "GET", () => /* ... renders `Hello site · ${selfSynth}` ... */)
  .setEndpoint("/news", "GET", () => /* ... renders `News feed · ${selfSynth}` ... */)
  .build();
await serveLibp2p({ node, protocol: WEBRUN_STREAMS_LIBP2P_PROTOCOL },
                  serveFetchOverDuplex(handler));

group.announceService({ id: "main-site", kind: "http", title: "Hello site", path: "/" });
group.announceService({ id: "news",      kind: "http", title: "News feed",  path: "/news" });
```

### Client page — observe the group and mount / unmount services

The client also calls `joinGroup` — the protocol is symmetric. Clients
publish announcements with `services: []` so server pages can see them in
their own group view.

```ts
const GROUP_ID =
  location.hash.slice(1) || import.meta.env.VITE_GROUP_ID || "default";
const SHARED_ADAPTER_KEY = "p2p-demo-mounts";

const node = await createBrowserLibp2pNode({ listen: ["/webrtc"], groupId: GROUP_ID });
const group = await joinGroup({ node, groupId: GROUP_ID });
// Clients don't call announceService; they're discoverable but offer nothing.

// One cached call handle per peerId — opened on first mount, closed when
// the peer evicts or its last mount unmounts. Yamux multiplexes concurrent
// HTTP requests across iframes sharing the same handle.
type CallHandle = { call: Duplex; close: () => Promise<void> };
const handles = new Map<string, CallHandle>();
const mounted = new Map<string, MountedEntry>();   // key: peerId:serviceId

// ── Shared SwHttpAdapter ─────────────────────────────────────────────────
// The SW dispatcher's handlersIndex is keyed by browser-client id — one
// entry per tab. If every HostedSiteBuilder built its own SwHttpAdapter,
// each new mount's UPDATE_COMMUNICATION_PORT would overwrite the previous
// mount's entry and only the most-recent site would route.
// Wire one adapter per tab; let HostedSiteBuilder add many handlers to its
// internal _handlers map (which routes by URL prefix).
const sharedAdapter = new SwHttpAdapter({
  key: SHARED_ADAPTER_KEY,
  serviceWorkerUrl: new URL("/sw-worker.js", location.href).toString(),
});
// Wrap so HostedSiteBuilder gets start/register but NOT stop. Per-mount
// unmount calls HostedSite.stop() → adapter.stop?.() — and the SwHttpAdapter
// inherits a stop() that unregisters the SW entirely, which would tear
// down every other mount. Omitting `stop` keeps the SW alive for the tab.
const sharedAdapterFactory = () => ({
  start: () => sharedAdapter.start(),
  register: (prefix, handler) => sharedAdapter.register(prefix, handler),
});

// ── Mount: open the dial, build a per-mount SiteHandler, render iframe ──
async function getOrOpenHandle(peerId: string): Promise<CallHandle> {
  const existing = handles.get(peerId);
  if (existing) return existing;
  // Construct the dial address from the known relay multiaddr. We do NOT
  // rely on peerStore multiaddrs because pubsub-peer-discovery broadcasts
  // whatever node.getMultiaddrs() returns at the moment — local-only on the
  // server before its circuit-relay reservation lands — and libp2p's auto-
  // dial may have already opened a *limited* relay-only connection that
  // rejects custom protocols. The /webrtc segment tells libp2p to upgrade
  // to a direct browser-to-browser WebRTC connection.
  const peerMa = multiaddr(`${relayMultiaddr}/p2p-circuit/webrtc/p2p/${peerId}`);
  await node.dial(peerMa);   // forces non-limited connection
  const handle = await connectLibp2p({ node, peer: peerMa, protocol: WEBRUN_STREAMS_LIBP2P_PROTOCOL });
  handles.set(peerId, handle);
  return handle;
}

async function mountService(peerId: string, service: HttpService): Promise<void> {
  const key = `${peerId}:${service.id}`;
  if (mounted.has(key)) return;
  const peerSynth = await ensureSynth(peerId);

  const site = await new HostedSiteBuilder({ adapterFactory: sharedAdapterFactory })
    // Site key starts with SHARED_ADAPTER_KEY so the SW's first-path-segment
    // lookup resolves to the shared adapter's port; the adapter's internal
    // _handlers map then routes to the right per-mount handler.
    .setSiteKey(`${SHARED_ADAPTER_KEY}/${peerSynth}-${service.id}`)
    .setHandler(async (req) => {
      // Look up the current handle on every request so a peer that evicts
      // and rejoins (same peerId) transparently reconnects on the next fetch.
      const h = await getOrOpenHandle(peerId).catch(() => undefined);
      if (!h) return new Response("peer disconnected", { status: 503 });
      return fetchOverDuplex(h.call, req);
    })
    .build();

  // site.baseUrl already ends with "/", so strip the leading "/" from the
  // service path; otherwise the iframe URL gets a `//` and relative hrefs
  // resolve against the doubled-slash form, which the SW rejects.
  const cleanPath = (service.path ?? "/").replace(/^\/+/, "");
  const iframe = appendIframe(site.baseUrl + cleanPath, service.title);
  mounted.set(key, { service, site, iframe });
}

async function unmountService(peerId: string, serviceId: string): Promise<void> {
  const key = `${peerId}:${serviceId}`;
  const entry = mounted.get(key);
  if (!entry) return;
  entry.iframe.remove();
  await entry.site.stop();   // removes this mount's handler from the shared adapter
  mounted.delete(key);
  // Last mount from this peer? Close the cached call handle.
  const stillUsed = [...mounted.keys()].some((k) => k.startsWith(`${peerId}:`));
  if (!stillUsed) {
    const handle = handles.get(peerId);
    if (handle) {
      void handle.close();
      handles.delete(peerId);
    }
  }
}

// Single change-handler does two jobs: re-render the list, and reconcile
// cached handles for peers that evicted while mounts of theirs remain.
group.on("change", (state) => {
  renderServiceList(state, mounted);   // includes ghost rows for evicted-but-mounted peers
  for (const [peerId, handle] of handles) {
    if (state.has(peerId)) continue;
    // Peer evicted from group. Mounted iframes show "disconnected" until
    // the user clicks [Unmount] on their ghost rows; we don't auto-close,
    // because the same (peerId, serviceId) may reappear and we want the
    // handle to be reopenable lazily by the next mount.
    void handle.close();
    handles.delete(peerId);
  }
});
```

### UI sketch (illustrative — exact markup grilled out at implementation time)

**Server page**

```
┌────────────────────────────────────────────────────────────────────┐
│  Server: ab12-cd34                                                 │ ← H1 with role + synth
├────────────────────────────────────────────────────────────────────┤
│ group: alpha · self: ab12-cd34 [SERVER]    status: connected       │ ← always visible
├────────────────────────────────────────────────────────────────────┤
│ My services (announced)                                            │
│   • main-site  — Hello site  (/)                                   │
│   • news       — News feed   (/news)                               │
├────────────────────────────────────────────────────────────────────┤
│ Peers in group (live)                                              │
│   9f7e-0001  [CLIENT]   0 services  · 1s ago                       │
│   77a3-be19  [SERVER]   1 service   · 2s ago                       │
├────────────────────────────────────────────────────────────────────┤
│ Activity log                                                       │
└────────────────────────────────────────────────────────────────────┘
```

The **Peers in group** section is the visible artifact of the symmetric
protocol — server pages see consumer-only peers (services=[]) too. It also
visually confirms group isolation: a tab in `#alpha` never lists `#beta`'s
peers. The `SERVER` / `CLIENT` badge is derived from `entry.services.length`
(non-empty → SERVER, empty → CLIENT).

**Client page**

```
┌────────────────────────────────────────────────────────────────────┐
│  Client: 9f7e-0001                                                 │ ← H1 with role + synth
├────────────────────────────────────────────────────────────────────┤
│ group: alpha · self: 9f7e-0001 [CLIENT]    status: connected       │ ← always visible
├────────────────────────────────────────────────────────────────────┤
│ Services in group (live)                                           │
│   Hello site   from ab12-cd34 [SERVER]   available    [Mount]      │
│   News feed    from ab12-cd34 [SERVER]   mounted      [Unmount]    │
│   Hello site   from 77a3-be19 [SERVER]   disconnected [Unmount]    │ ← evicted, iframe still up
├────────────────────────────────────────────────────────────────────┤
│ Mounted (stacked)                                                  │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │ News feed · ab12-cd34                       [● connected] │   │
│   │ <iframe>                                                   │   │
│   │   ┌─────────────────────────────────────────────┐          │   │
│   │   │ News feed · ab12-cd34                       │ ← served │   │
│   │   │ Group: alpha                                │   HTML   │   │
│   │   │ · Server peer is online.                    │ embeds   │   │
│   │   │ · …                                          │  synth  │   │
│   │   └─────────────────────────────────────────────┘          │   │
│   └────────────────────────────────────────────────────────────┘   │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │ Hello site · 77a3-be19              [○ disconnected]      │   │
│   │ <iframe (dimmed)>                                          │   │
│   └────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

The **Services in group** list is the single control surface for mounting
and unmounting. Each row has one toggle button:

| Row state | Button | Notes |
|---|---|---|
| Service announced, not mounted | `[Mount]` | The happy path |
| Service announced, currently mounted | `[Unmount]` | Cleanly tears down iframe + closes the cached call handle if it was this peer's last mount |
| Service no longer announced but iframe still mounted (peer evicted) | `[Unmount]` | The row stays in the list as a "ghost" entry **only because it has a live mount**; row disappears when unmounted |

Consequences:
- A user can always clean up a disconnected iframe by clicking `[Unmount]` in the list — no need for a per-card close button.
- The Mounted iframes section is purely a view. It never has its own controls.
- If a disconnected service's peer re-joins (same `peerId` + `serviceId`), the row flips back from `disconnected [Unmount]` to `mounted [Unmount]` and the cached call handle is re-opened; the iframe re-animates without the user doing anything.

Behavior locked in:
- **Iframes stacked vertically** (no tabs / grid).
- **Disconnected iframes never auto-evict** — the user controls cleanup via the Services list.

### Failure / edge paths

Concentrated overview; each is covered by the surrounding sections.

| Scenario | Behavior | Where it's specified |
|---|---|---|
| Relay unreachable on boot | Both pages show "cannot dial relay" in status; `joinGroup` never resolves | Constraints (relay is the only bootstrap path) |
| Relay dies after boot | Existing direct-WebRTC peer connections survive; group view freezes; no new peers discovered | Constraints |
| Peer evicted mid-fetch (TTL expires while an HTTP request is in flight) | The in-flight `fetchOverDuplex` rejects; iframe surfaces the network error; row becomes a "ghost" `[Unmount]` row | Lifecycle defaults + UI sketch |
| `groupId` missing in URL fragment and env | Falls back to `"default"` group — no error | `How to use` |
| `announceService` called before gossipsub mesh is fully bootstrapped | First publish may not reach anyone; the next tick (≤5s later) catches up | Lifecycle defaults (Tick + on-change + on-new-peer) |
| Same `(peerId, serviceId)` reappears after eviction | Ghost row flips back to `mounted`; call handle is re-opened lazily on next request | UI sketch |

## Internals

```
apps/p2p-demo/
├── lib/
│   ├── group-topics.ts        # peerDiscoveryTopic(g) / servicesTopic(g) — naming convention
│   ├── announcement.ts        # ServiceAnnouncement types + JSON encode/decode (services topic only)
│   ├── group-state.ts         # pure receiver state machine (applyAnnouncement / applyLeave / evictStale)
│   ├── join-group.ts          # joinGroup(): subscribe to services topic + tick (5s) + sweep (1s) + on-new-peer + beforeunload leave
│   ├── peer-id-synth.ts       # SHA-1-derived synthetic id ("abcd-1234"); cached + async; onSynthCacheUpdate subscription
│   └── browser-node.ts        # libp2p factory — registers pubsub: gossipsub() + peerDiscovery: [pubsubPeerDiscovery({topics:[peer-discovery]})]
├── relay/
│   └── server.ts              # Node libp2p Circuit Relay v2 + gossipsub forwarder + auto-subscribe to webrun/* topics
├── server-page/
│   ├── index.html             # H1 (Server: <synth>) + status header + My services + Peers in group + Activity log
│   └── main.ts                # SiteHandler (/, /news, /api/*) with synth in served HTML titles; serveLibp2p; joinGroup; announceService×2
├── client-page/
│   ├── index.html             # H1 (Client: <synth>) + status header + Services in group (live) + Mounted (stacked) + Activity log
│   └── main.ts                # shared SwHttpAdapter + cached call handles + explicit relay→circuit→webrtc dial + mount/unmount + ghost rows
└── scripts/
    └── start.sh               # boots relay, parses multiaddr, injects VITE_RELAY_MULTIADDR + VITE_GROUP_ID
```

### Architecture: split-topic discovery

Two gossipsub topics per group serve different concerns. The split is the
demo's main architectural pivot — it isolates the off-the-shelf code paths
from the bespoke ones and pre-shapes the future `webrun-p2p-mesh` package.

| Topic | Owner | Carries | Used for |
|---|---|---|---|
| `webrun/<groupId>/peer-discovery` | `@libp2p/pubsub-peer-discovery` (off-the-shelf) | `{peerId, multiaddrs}` (protobuf) | libp2p auto-discovery + auto-dial — connections are pre-warmed in the background so the first `[Mount]` is instant |
| `webrun/<groupId>/services` | This app (`lib/join-group.ts`) | `ServiceAnnouncement` (JSON; see Examples) | The application-level "who is here and what do they offer" map |

The library handles all peer/multiaddr bookkeeping in libp2p's peerStore.
At mount time the client queries `node.peerStore.get(peerId)` for dialable
addresses; it never sees the peer-discovery wire format.

The service catalog is fully owned by `lib/join-group.ts`. It runs the
single-topic protocol (5s tick + on-change + on-new-peer + beforeunload
leave) and maintains `Map<peerId, {services, lastSeen}>`. The two topic
TTL windows aren't currently joined: a peer that drops out of
peer-discovery but is still announcing services would render as
"available, no dialable addresses" — fine in practice because both
topics share the same 5s heartbeat.

Key invariants:

- **`joinGroup` is the only application-level entry point.** Both pages
  call it the same way; the only difference is whether they call
  `announceService(...)` afterwards.
- **ServiceAnnouncements are full snapshots, not diffs.** Receivers
  `state.set(peerId, …)` per message — no merging at the protocol layer.
  Per-peer eviction follows naturally.
- **The mounted-iframe handler looks up the current call handle on every
  fetch**, so a peer that evicts and rejoins (same peerId) transparently
  reconnects on the next request. The cached handle is recreated lazily.
- **The Services list is the single control surface** for mounting and
  unmounting. The Mounted-iframes section has no controls of its own.
  Ghost rows (peer evicted but iframe still up) provide the unmount path.
- **One shared `SwHttpAdapter` per client tab** (key
  `"p2p-demo-mounts"`). The SW dispatcher's `handlersIndex` is keyed by
  browser-client id — one entry per tab — so each new mount's
  `UPDATE_COMMUNICATION_PORT` would overwrite the previous mount's entry
  if every `HostedSiteBuilder` constructed its own adapter. We wrap the
  shared adapter to expose `start` / `register` but not `stop`, so
  per-mount `HostedSite.stop()` only deletes its own handler from the
  adapter's `_handlers` map and the SW stays alive for the tab.
- **The client dial constructs `${relay}/p2p-circuit/webrtc/p2p/<peerId>`
  unconditionally and calls `node.dial(peerMa)` before `connectLibp2p`.**
  The `/webrtc` segment forces libp2p to upgrade to direct WebRTC;
  without the explicit dial, an existing limited circuit-relay
  connection (from libp2p's auto-dial via pubsub-peer-discovery) silently
  rejects custom protocols.

### Constraints

- Localhost only (plain `ws://` relay). Production deployment is out of scope.
- The relay is the **only** bootstrap path: every browser dials the relay on
  load, both gossipsub topics mesh over relay-mediated connections, and
  peers upgrade to direct WebRTC once they've seen each other's
  announcements. If the relay disappears, existing WebRTC connections
  keep working but the group view freezes (no new discovery).
- The relay adds `pubsub: gossipsub()` to its services **and** auto-
  subscribes to any `webrun/*` topic it sees a connected peer advertise.
  Gossipsub only forwards messages between peers that are both subscribed
  to a topic — a non-subscribed intermediate has no slot in the mesh — so
  the relay must join each group's topic to bridge browsers. The auto-
  subscribe pattern keeps the relay's app-level knowledge to zero (no
  topic list baked in, no per-group config) while still putting it on the
  right meshes; it runs no handler, just forwards. Both
  `webrun/<g>/peer-discovery` and `webrun/<g>/services` match the same
  rule.
- The shared `createBrowserLibp2pNode` factory (`lib/browser-node.ts`)
  registers `pubsub: gossipsub()` **and**
  `peerDiscovery: [pubsubPeerDiscovery({topics: [peer-discovery topic]})]`
  in its libp2p config. Both must be registered at node-creation time —
  they cannot be added later. The factory takes `groupId` so the
  peer-discovery topic name is known at registration time.
- WebTransport, DHT, rendezvous, mDNS, and `libp2p-daemon-*` are explicitly
  **not** in scope for this iteration.

### Lifecycle defaults

| Knob | Value | Reasoning |
|---|---|---|
| Re-broadcast interval (K) | **5 s** | Snappy enough that newly opened tabs feel instant after the on-new-peer publish |
| Staleness window (T) | **15 s** = 3 × K | Tolerates one missed broadcast plus slack before evicting |
| Eviction sweep | **1 s** | Bounded gap between TTL expiry and visible eviction |
| Eviction mechanism | **TTL + explicit "leave" on `beforeunload`** (best-effort) | Instant clean-shutdown UX; TTL is the safety net for crashes / forced close |
| Eviction granularity | **Per-peer** | Each announcement is the peer's full current catalog; clients reconcile by array-replace |
| Publish triggers | **Tick + on-change + on-new-peer** | Reactive; bounded chatter; new peers don't wait one full tick |
| Mounted-iframe behavior when source peer vanishes | **Iframe stays, "disconnected" badge**; user unmounts via the Services list row; auto-reconnects if same `(peerId, serviceId)` reappears | Never yank an iframe mid-interaction; the Services list is the single control surface |

### Dependencies

Added in this iteration:

- [`@chainsafe/libp2p-gossipsub`](https://www.npmjs.com/package/@chainsafe/libp2p-gossipsub)
  — gossipsub pubsub. Registered in both the browser-node factory and the
  relay. Configured with `allowPublishToZeroTopicPeers: true` so the first
  publish before the mesh forms doesn't throw.
- [`@libp2p/pubsub-peer-discovery`](https://www.npmjs.com/package/@libp2p/pubsub-peer-discovery)
  (`^11.0.2`, paired with libp2p v2 / multiaddr v12) — owns the
  `webrun/<g>/peer-discovery` topic. Periodically broadcasts the local
  peerId + multiaddrs; libp2p's connection manager auto-dials peers it
  hears about, pre-warming connections in the background.
- [`@libp2p/peer-id`](https://www.npmjs.com/package/@libp2p/peer-id) — used
  by the client page to parse string peer ids returned from our service
  catalog into the `PeerId` objects libp2p's peerStore expects.

Carried over unchanged:

- `libp2p`, `@libp2p/identify`, `@libp2p/circuit-relay-v2`, `@libp2p/webrtc`,
  `@libp2p/websockets`, `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`
  — the existing libp2p transport stack.
- `@statewalker/webrun-streams`, `@statewalker/webrun-streams-libp2p` — the
  `Connect/Serve/Duplex` seam (ADR-0004).
- `@statewalker/webrun-site-builder`, `@statewalker/webrun-site-host`,
  `@statewalker/webrun-http-streams`, `@statewalker/webrun-http-browser` —
  the `SiteHandler` shape and same-origin SW mount.
- `@multiformats/multiaddr` — multiaddr parsing.

## License

MIT © statewalker
