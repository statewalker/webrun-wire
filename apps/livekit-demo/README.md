# livekit-demo

Cross-app HTTP + SSE demonstration using **LiveKit** as the initialisation
and transport layer. Mirror of [p2p-demo](../p2p-demo/) with a LiveKit room
replacing the libp2p Circuit Relay v2 + WebRTC link.

## Pieces

| Piece | What it is | Listens on |
| --- | --- | --- |
| `livekit-server` (Docker, `livekit-server --dev`) | LiveKit SFU + signalling | `ws://localhost:7880` (+ 7881/tcp, 7882/udp) |
| `token-service/server.ts` | Node HTTP service; signs JWTs with the dev API key | `http://localhost:9091/token` |
| `server-page/` | Browser app: joins the LiveKit room as `site-server`, and for each remote participant registers the same `SiteHandler` with `serve({ room, peerIdentity })` from `@statewalker/webrun-streams-livekit`, wrapped in `serveFetchOverDuplex` | `http://localhost:5275` |
| `client-page/` | Browser app: joins the same room with a random identity, opens a `Duplex` to `site-server` with `connect({ room, peerIdentity })`, and exposes the remote site via `HostedSiteBuilder` + SW, whose handler is `(req) => fetchOverDuplex(call, req)` | `http://localhost:5276` |

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
   participant to appear, then opens a `Duplex` against it.
3. The client polls `GET /api/time` over the new `Duplex` until it answers,
   then its `HostedSiteBuilder` registers a SW and points an iframe at the
   resulting `site.baseUrl`. The iframe loads `GET /` from the server;
   in-iframe `fetch("api/time")` is transparently forwarded over the LiveKit
   data channel.
4. The **Subscribe** button calls `fetchOverDuplex` directly for
   `/api/events`, parses the SSE stream, appends each `{tick:N}` to the
   on-screen log. **Stop** aborts the request via the `Request`'s
   `AbortSignal` — server-side cancellation propagates the same way as in
   `p2p-demo`.

## Architecture & seam

- **Same `SiteHandler` shape** as `p2p-demo`. The only difference is *which*
  `webrun-streams-*` adapter supplies the `Duplex`:
  `@statewalker/webrun-streams-libp2p` there,
  `@statewalker/webrun-streams-livekit` here. Everything above the `Duplex`
  seam — `serveFetchOverDuplex`, `fetchOverDuplex`, `SiteBuilder`,
  `HostedSiteBuilder` — is identical.
- The token service is the LiveKit equivalent of the libp2p relay's "give
  me the rendezvous address" step — it issues a credential rather than
  publishing a multiaddr.
- Identity is the routing primitive (instead of a peer id). Outbound data
  packets carry `destinationIdentities`; inbound packets are filtered by
  sender identity inside `byteChannelFromLiveKit`, on top of which
  `emulateMux` provides the multi-stream layer.

## Project layout

```
apps/livekit-demo/
├── package.json
├── tsconfig.json
├── vite.server.config.ts        # serves server-page/ on 5275
├── vite.client.config.ts        # serves client-page/ on 5276 (+ sw-worker.js)
├── token-service/server.ts      # Node HTTP server, livekit-server-sdk AccessToken
├── server-page/                 # SiteBuilder + serveFetchOverDuplex + serve() per participant
├── client-page/                 # HostedSiteBuilder + fetchOverDuplex + iframe + SSE
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

## Dependencies

Workspace: [`webrun-streams`](../../packages/webrun-streams), [`webrun-streams-livekit`](../../packages/webrun-streams-livekit), [`webrun-http-streams`](../../packages/webrun-http-streams), [`webrun-site-builder`](../../packages/webrun-site-builder), [`webrun-site-host`](../../packages/webrun-site-host).

Vendor: `livekit-client` (^2.18.3), `livekit-server-sdk` (^2.10.0).

Dev: `vite`, `typescript`, `tsx`, `@types/node`, [`webrun-http-browser`](../../packages/webrun-http-browser). Docker is required for the dev LiveKit server.

## License

Private demo, not published. MIT © statewalker — see [LICENSE](../../LICENSE).
