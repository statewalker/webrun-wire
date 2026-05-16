# livekit-demo

Cross-app HTTP + SSE demonstration using **LiveKit** as the initialisation
and transport layer. Mirror of [p2p-demo](../p2p-demo/) with a LiveKit room
replacing the libp2p Circuit Relay v2 + WebRTC link.

## Pieces

| Piece | What it is | Listens on |
| --- | --- | --- |
| `livekit-server` (Docker, `livekit-server --dev`) | LiveKit SFU + signalling | `ws://localhost:7880` (+ 7881/tcp, 7882/udp) |
| `token-service/server.ts` | Node HTTP service; signs JWTs with the dev API key | `http://localhost:9091/token` |
| `server-page/` | Browser app: joins the LiveKit room as `site-server`, hosts a `SiteHandler` per remote participant via `createLiveKitPort` + `PortSiteBuilder` | `http://localhost:5275` |
| `client-page/` | Browser app: joins the same room with a random identity, opens `createLiveKitPort` to `site-server`, exposes the remote site via `HostedSiteBuilder` + SW | `http://localhost:5276` |

Data flows peer-to-peer over LiveKit's per-participant data channel
(`localParticipant.publishData` with `destinationIdentities`).

## Quick start

From `workspaces/webrun-wire/`:

```sh
pnpm install
pnpm --filter @statewalker/livekit-demo start
```

Or from this directory:

```sh
pnpm start
```

The launcher:

1. Probes `:7880`; if no LiveKit server is reachable, runs the official Docker
   image in dev mode (`livekit/livekit-server:latest --dev`). Requires Docker
   if the port is empty. Set `SKIP_LIVEKIT_SERVER=1` (and a custom
   `LIVEKIT_URL`) to plug in your own server.
2. Starts the token service on `:9091`.
3. Starts both Vite dev servers (`5275`, `5276`).
4. Ctrl-C tears all of them down.

## Flow

1. Open <http://localhost:5275> — server page connects to the room as
   identity `site-server`. UI shows status.
2. Open <http://localhost:5276> — client page connects with a fresh random
   identity (`site-client-<short uuid>`), waits for the `site-server`
   participant to appear, then opens a `MessagePort` against it.
3. The client's `HostedSiteBuilder` registers a SW under
   `<origin>/livekit-site-server/...` and points an iframe at the resulting
   `site.baseUrl`. The iframe loads `GET /` from the server; in-iframe
   `fetch("api/time")` is transparently forwarded over the LiveKit data
   channel.
4. The **Subscribe** button calls `fetchOverPort` directly for
   `/api/events`, parses the SSE stream, appends each `{tick:N}` to the
   on-screen log. **Stop** aborts the request — server-side cancellation
   propagates the same way as in `p2p-demo`.

## Architecture & seam

- **Same `SiteHandler` shape** as `p2p-demo`. The only difference is
  *which* `MessagePort` factory we use: `createLibp2pStreamPort(stream)`
  there, `createLiveKitPort(room, identity)` here. Everything above the
  port is identical.
- The token service is the LiveKit equivalent of the libp2p relay's "give
  me the rendezvous address" step — it issues a credential rather than
  publishing a multiaddr.
- Identity is the routing primitive (instead of a peer id). Outbound data
  packets carry `destinationIdentities`; inbound packets are filtered by
  sender identity inside `createLiveKitPort`.

## Project layout

```
apps/livekit-demo/
├── package.json
├── tsconfig.json
├── vite.server.config.ts        # serves server-page/ on 5275
├── vite.client.config.ts        # serves client-page/ on 5276 (+ sw-worker.js)
├── token-service/server.ts      # Node HTTP server, livekit-server-sdk AccessToken
├── server-page/                 # SiteBuilder + PortSiteBuilder + per-participant ports
├── client-page/                 # HostedSiteBuilder + fetchOverPort + iframe + SSE
├── lib/
│   ├── config.ts                # shared constants (URLs, room name, identities)
│   └── livekit-room.ts          # fetch token → Room.connect helper
└── scripts/start.sh             # boots all four (Docker server + Node service + 2 vite)
```

## Caveats

- **Dev credentials** (`devkey` / `secret`) are baked into the token service
  for zero-config local use. **Never use these in production** — the token
  service would be a credential factory for anyone who can hit it.
- **Localhost only.** LiveKit's `--dev` mode binds to `0.0.0.0` inside the
  Docker container with ports forwarded from `localhost`. Production
  deployments use TLS-fronted signalling (`wss://`) and TURN credentials.
- **First Docker run pulls ~80 MB.** Subsequent runs reuse the cached image.
- **Identity collisions** — if two server pages try to join with
  `site-server` simultaneously, LiveKit allows the second one and may kick
  the first. Reload causes a brief blip; usually self-heals.
