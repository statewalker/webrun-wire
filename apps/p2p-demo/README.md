# p2p-demo

End-to-end demonstration that two browser apps can exchange HTTP — including
SSE — across a direct browser-to-browser libp2p WebRTC connection, with no
domains and no TLS certs on the application layer.

The project bundles three pieces:

| Piece | What it is | Listens on |
| --- | --- | --- |
| `relay/server.ts` | Node libp2p Circuit Relay v2 over plain WS | `ws://127.0.0.1:9090` |
| `server-page/` | Browser app: `SiteBuilder` + `PortSiteBuilder` over each accepted libp2p stream | `http://localhost:5175` |
| `client-page/` | Browser app: dials the server peer, exposes its site via `HostedSiteBuilder` + SW | `http://localhost:5176` |

The relay only carries the libp2p handshake and Circuit-Relay-v2 protocol —
once the two browsers upgrade to direct WebRTC, **HTTP bytes flow peer-to-peer**
and do not pass through the relay.

## Quick start

From `workspaces/webrun-wire/`:

```sh
pnpm install
pnpm demo:p2p           # or:  pnpm --filter @statewalker/p2p-demo start
```

Or from this directory:

```sh
pnpm start              # boots all three in one terminal
```

The launcher:

1. Starts the relay; parses its full multiaddr from stdout
2. Exports it as `VITE_RELAY_MULTIADDR` for the two Vite dev servers
3. Boots `server-page` (port 5175) and `client-page` (port 5176) in parallel
4. Ctrl-C tears down all three

Set `RELAY_PORT=9091 pnpm start` if 9090 is in use.

## Flow

1. Open <http://localhost:5175> — server page initialises a browser libp2p
   node, dials the relay, reserves a Circuit-Relay-v2 slot, and prints its
   **peer id** (and dial-able multiaddr).
2. Open <http://localhost:5176> — client page does the same, then waits for
   you to paste the server's peer id.
3. Paste → click **Connect**. The client dials
   `${RELAY}/p2p-circuit/webrtc/p2p/<server>`, libp2p upgrades to direct
   WebRTC, opens a `/webrun/port-bytes/1.0.0` stream, and wraps it in a
   `MessagePort` via `@statewalker/webrun-port-libp2p`.
4. The client's `HostedSiteBuilder` registers a ServiceWorker that proxies
   every fetch under `<origin>/<siteKey>/...` via `fetchOverPort(port, req)`
   to the remote peer. The iframe loads `site.baseUrl` and renders the
   server's `GET /` HTML; the in-iframe `fetch("api/time")` is transparently
   forwarded over libp2p.
5. Outer-page **Subscribe** button calls `fetchOverPort` directly for
   `/api/events`, parses the SSE stream, appends each `{tick:N}` to the
   on-screen log. **Stop** aborts the request — server-side cancellation
   fires via `ReadableStream.cancel()`.

## Architecture & seam

- `SiteBuilder` (in `webrun-site-builder`) composes endpoints into a single
  `(Request) ⇒ Promise<Response>` — the `SiteHandler`.
- `PortSiteBuilder` (in `webrun-http-port`) hosts a `SiteHandler` over a
  `MessagePort`. Server-side: one fresh `PortSiteBuilder` per accepted
  libp2p stream, all sharing the same `SiteHandler` instance.
- `HostedSiteBuilder` (in `webrun-site-host`) hosts a `SiteHandler` behind a
  same-origin ServiceWorker. Client-side: a single forwarding handler whose
  body is `(req) => fetchOverPort(activePort, req)`.

The same `SiteHandler` shape works in both `*SiteBuilder`s — that is the
demonstrated seam.

## Project layout

```
apps/p2p-demo/
├── package.json               # one project, three startable surfaces
├── tsconfig.json              # shared TS config (DOM + Node lib)
├── vite.server.config.ts      # serves server-page/ on 5175
├── vite.client.config.ts      # serves client-page/ on 5176 (+ sw-worker.js)
├── relay/server.ts            # Node libp2p Circuit Relay v2
├── server-page/               # SiteBuilder + PortSiteBuilder
├── client-page/               # HostedSiteBuilder + fetchOverPort + iframe + SSE
├── lib/browser-node.ts        # shared libp2p browser-node factory + relay-config guard
└── scripts/start.sh           # boots all three with one Ctrl-C teardown
```

## Caveats

- **Localhost only.** The relay uses plain `ws://` because browsers permit
  insecure WS to `localhost`. Production cross-app deployments would need
  WSS + a stable hostname.
- **WebRTC upgrade is best-effort.** If NAT/firewall blocks it, libp2p falls
  back to circuit-relay (bytes flow through the relay, slower but
  functional). The "limited=true/false" status line reports which path the
  connection chose.
- **No persistence.** Both browser pages generate a fresh libp2p peer id on
  each load; reloading the server tab means re-pasting its new peer id into
  the client.
