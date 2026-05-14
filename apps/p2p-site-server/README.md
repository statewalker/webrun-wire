# p2p-site-server

Browser-side libp2p peer that hosts a `SiteHandler` over every accepted
`/webrun/port-bytes/1.0.0` stream. Paired with the
[p2p-site-client](../p2p-site-client/) app via the
[p2p-relay](../p2p-relay/) bootstrap.

## Endpoints

The handler is composed via `SiteBuilder`:

- `GET /` — minimal HTML page that calls `/api/time` and renders the result.
- `GET /api/time` — JSON `{ now: <ISO-8601 timestamp> }`.
- `GET /api/events` — Server-Sent Events stream emitting
  `data: {"tick": N}\n\n` once per second. Cancels when the consumer goes
  away (relies on `ReadableStream.cancel`).

## Run

```sh
# 1. Start the relay (separate terminal):
pnpm --filter @statewalker/p2p-relay start
#    Copy the printed multiaddr (the line with /p2p/<peerId>).

# 2. Plug the multiaddr into either RELAY_MULTIADDR (top of src/main.ts)
#    or set it via env when starting the dev server:
VITE_RELAY_MULTIADDR="/ip4/127.0.0.1/tcp/9090/ws/p2p/<peerId>" pnpm dev
```

The dev server runs on `http://localhost:5175`. Open it in a browser tab —
the page initialises a browser libp2p node, dials the relay, and reserves a
Circuit Relay v2 slot. The UI displays:

- the server's libp2p peer id (copy button),
- the dial-able multiaddr (the one a client should paste in),
- a live status log of relay reservations and inbound connections.

## How to share the peer id

The peer id changes on every page reload (the libp2p node generates a fresh
identity). Copy it from the UI and paste it into the client app's input
field. Re-load the server tab → re-paste in the client.

## Troubleshooting

- **`peer id stays "(initialising…)"`** — the libp2p node failed to start.
  Open the console; usually a transport-config error.
- **`dial-able address never appears`** — the relay reservation didn't
  complete. Check the relay terminal for the dialled peer; ensure the
  `RELAY_MULTIADDR` matches the relay's printed multiaddr exactly (peer id
  and port included).
- **WebRTC upgrade fails** — the connection falls back to circuit-relay. The
  bytes flow through the relay, slower but functional. Look at the network
  inspector's WebRTC pane to confirm.

## What this app does NOT do

- No TLS — relies on the relay being on `localhost` (browsers permit plain
  WS to `127.0.0.1`). Production cross-app deployments would need WSS.
- No persistence — peer id, accepted connections, and emitted ticks are all
  in-memory; reload resets everything.
- No reconnection — one peer id per page load.
