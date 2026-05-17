# p2p-demo

## What it is

End-to-end demonstration that browser pages, told only that they belong to
the same **group**, find each other on the network, announce what HTTP
resources they offer, and start serving those resources to each other —
**without any peer-id paste step**.

The demo ships two page roles, both of which can run in any number of tabs:

- **Server page** — registers one or more HTTP services on a local
  `SiteHandler`, announces them on the group's gossipsub topic.
- **Client page** — discovers every service offered by every server in the
  group, lists them, and mounts each chosen service in its own iframe behind
  a same-origin ServiceWorker. The list is **live**: when a server page
  vanishes, its services disappear from the list within the staleness window,
  and any iframe mounted from it surfaces a clear "disconnected" state.

All discovery (peers + services) flows through one shared gossipsub topic;
the HTTP traffic itself flows peer-to-peer over the existing
`Connect/Serve/Duplex` libp2p adapter from ADR-0004.

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

**Both pages always display the active `groupId` and self peerId** in the
status header — there's no way to be unsure which group a tab is in.

Open additional server-page tabs to add more services to the same group;
client-page tabs see the new services within one announcement interval (≤5s).

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
  multiaddrs: string[];
  services: Service[];                     // may be empty for consumer-only peers
  lastSeen: number;
};

declare function joinGroup(params: {
  node: Libp2p;
  groupId: string;
}): Promise<GroupHandle>;
```

Symmetric: client pages call `joinGroup` and publish with `services: []`.
The protocol has no consumer-only mode.

### Wire shape — the announcement message

```ts
type Announcement = {
  v: 1;                       // schema version
  peerId: string;             // self
  multiaddrs: string[];       // dial-able addresses (e.g. /p2p-circuit/webrtc/p2p/<id>)
  services: Service[];        // capability catalog; may be empty
  ts: number;                 // unix ms — staleness math on receivers
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

// createBrowserLibp2pNode is updated as part of this change to register
// `pubsub: gossipsub()` in its services — required for joinGroup.
const node = await createBrowserLibp2pNode({ listen: ["/webrtc", "/p2p-circuit"] });
const group = await joinGroup({ node, groupId: GROUP_ID });

// Same SiteHandler shape as today — see ADR-0004.
const handler = new SiteBuilder()
  .setEndpoint("/", "GET", () => /* ... */)
  .setEndpoint("/news", "GET", () => /* ... */)
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

const node = await createBrowserLibp2pNode({ listen: ["/webrtc"] });
const group = await joinGroup({ node, groupId: GROUP_ID });
// Clients don't call announceService; they're discoverable but offer nothing.

// One cached call handle per peerId — opened on first mount, closed when
// the peer evicts or its last mount unmounts. Yamux multiplexes concurrent
// HTTP requests across iframes sharing the same handle.
type CallHandle = { call: Duplex; close: () => Promise<void> };
const handles = new Map<string, CallHandle>();
const mounted = new Map<string /* peerId:serviceId */, { unmount: () => void }>();

// Prefer the /p2p-circuit/webrtc/... entry — that's the WebRTC-upgradable
// form; libp2p will dial through the relay then upgrade to direct.
function pickDialAddr(multiaddrs: string[]): string {
  return multiaddrs.find((m) => m.includes("/webrtc")) ?? multiaddrs[0];
}

async function getHandle(peerId: string, multiaddrs: string[]): Promise<CallHandle> {
  const existing = handles.get(peerId);
  if (existing) return existing;
  const peerMa = multiaddr(pickDialAddr(multiaddrs));
  const handle = await connectLibp2p({ node, peer: peerMa, protocol: WEBRUN_STREAMS_LIBP2P_PROTOCOL });
  handles.set(peerId, handle);
  return handle;
}

async function mountService(peerId: string, service: HttpService): Promise<void> {
  const key = `${peerId}:${service.id}`;
  if (mounted.has(key)) return;                                  // already mounted
  const { multiaddrs } = group.state.get(peerId)!;
  const { call } = await getHandle(peerId, multiaddrs);

  const site = await new HostedSiteBuilder()
    .setSiteKey(`${peerId.slice(0, 12)}-${service.id}`)
    .setHandler((req) => fetchOverDuplex(call, req))
    .build();

  const iframe = appendIframe(site.baseUrl + (service.path ?? "/"), service.title);
  mounted.set(key, { unmount: () => iframe.remove() });
}

async function unmountService(peerId: string, serviceId: string): Promise<void> {
  const key = `${peerId}:${serviceId}`;
  const entry = mounted.get(key);
  if (!entry) return;
  entry.unmount();
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
    // Peer evicted from group. The mounted iframes show "disconnected" until
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
┌──────────────────────────────────────────────────────────┐
│ group: alpha · self: 12D3KooW1xY…ab    status: connected │  ← always visible
├──────────────────────────────────────────────────────────┤
│ My services (announced)                                  │
│   • main-site  — Hello site  (/)                         │
│   • news       — News feed   (/news)                     │
├──────────────────────────────────────────────────────────┤
│ Peers in group (live)                                    │
│   12D3KooW2nQ…cd  ·  client      (0 services)  · 1s ago  │
│   12D3KooW3rS…ef  ·  server      (1 service)   · 2s ago  │
├──────────────────────────────────────────────────────────┤
│ Activity log                                              │
└──────────────────────────────────────────────────────────┘
```

The **Peers in group** section is the visible artifact of the symmetric
protocol — server pages see consumer-only peers (services=[]) too. It also
visually confirms group isolation: a tab in `#alpha` never lists `#beta`'s
peers.

**Client page**

```
┌──────────────────────────────────────────────────────────┐
│ group: alpha · self: 12D3KooW9zX…uv    status: connected │  ← always visible
├──────────────────────────────────────────────────────────┤
│ Services in group (live)                                  │
│   ▸ Hello site   12D3KooW1xY…ab  available    [Mount]   │
│   ▸ News feed    12D3KooW1xY…ab  mounted      [Unmount] │
│   ▸ Hello site   12D3KooW3rS…ef  disconnected [Unmount] │  ← evicted from group, iframe still up
├──────────────────────────────────────────────────────────┤
│ Mounted iframes (stacked)                                │
│   ┌──────────────────────────────────────────────────┐   │
│   │ News feed · 12D3KooW1xY…ab          [● connected]│   │
│   │ <iframe>                                         │   │
│   └──────────────────────────────────────────────────┘   │
│   ┌──────────────────────────────────────────────────┐   │
│   │ Hello site · 12D3KooW3rS…ef    [○ disconnected]  │   │
│   │ <iframe (dimmed)>                                │   │
│   └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
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
│   ├── announcement.ts        # on-wire types + JSON encode/decode
│   ├── group-state.ts         # pure receiver state machine (applyAnnouncement / applyLeave / evictStale)
│   ├── join-group.ts          # joinGroup(): subscribe + tick (5s) + sweep (1s) + on-new-peer + beforeunload leave
│   └── browser-node.ts        # libp2p factory with pubsub: gossipsub() in services
├── relay/
│   └── server.ts              # Node libp2p Circuit Relay v2 + gossipsub forwarder
├── server-page/
│   ├── index.html             # status header + My services + Peers in group + Activity log
│   └── main.ts                # SiteHandler (/, /news, /api/*), serveLibp2p, joinGroup, announceService×2
├── client-page/
│   ├── index.html             # status header + Services in group (live) + Mounted (stacked) + Activity log
│   └── main.ts                # cached call handles + mount/unmount + ghost rows + render loop
└── scripts/
    └── start.sh               # boots relay, parses multiaddr, injects VITE_RELAY_MULTIADDR + VITE_GROUP_ID
```

Key invariants worth knowing while reading the code:

- **`joinGroup` is the only entry point** to the discovery protocol. Both
  pages call it the same way; the only difference is whether they call
  `announceService(...)` afterwards.
- **Announcements are full snapshots, not diffs.** Receivers `state.set(peerId, …)`
  per message — no merging at the protocol layer. This is why per-peer
  eviction is the right granularity.
- **The mounted-iframe handler looks up the current call handle on every
  fetch**, so a peer that evicts and rejoins (same peerId) transparently
  reconnects on the next request. The cached handle is recreated lazily.
- **The Services list is the single control surface** for mounting and
  unmounting. The Mounted-iframes section has no controls of its own.
  Ghost rows (peer evicted but iframe still up) provide the unmount path.

### Constraints

- Localhost only (plain `ws://` relay). Production deployment is out of scope.
- The relay is the **only** bootstrap path: every browser dials the relay on
  load, the gossipsub mesh forms over relay-mediated connections, and peers
  upgrade to direct WebRTC once they've seen each other's announcements. If
  the relay disappears, existing WebRTC connections keep working but the
  group view freezes (no new discovery).
- The relay adds `pubsub: gossipsub()` to its services **and** auto-
  subscribes to any `webrun/*` topic it sees a connected peer advertise.
  Gossipsub only forwards messages between peers that are both subscribed
  to a topic — a non-subscribed intermediate has no slot in the mesh — so
  the relay must join each group's topic to bridge browsers. The auto-
  subscribe pattern keeps the relay's app-level knowledge to zero (no
  topic list baked in, no per-group config) while still putting it on the
  right meshes; it runs no handler, just forwards.
- The shared `createBrowserLibp2pNode` factory (`lib/browser-node.ts`)
  registers `pubsub: gossipsub()` in its services. Pubsub must be registered
  at libp2p creation time — it cannot be added later. `joinGroup` assumes
  the node was created with gossipsub available.
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
