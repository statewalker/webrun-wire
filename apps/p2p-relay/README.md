# p2p-relay

Tiny Node libp2p Circuit Relay v2 over plain WebSocket on `127.0.0.1`. Used by
the [p2p-site-server](../p2p-site-server/) and [p2p-site-client](../p2p-site-client/)
browser apps as a bootstrap rendezvous: peers dial the relay over plain `ws://`,
exchange ICE candidates via Circuit Relay v2, then upgrade to a direct
browser-to-browser WebRTC connection.

## Run

```sh
pnpm install            # from workspaces/webrun-wire/
pnpm --filter @statewalker/p2p-relay start
```

Or from this directory:

```sh
pnpm start
```

By default it listens on `/ip4/127.0.0.1/tcp/9090/ws`. Override with
`RELAY_PORT=<port>`.

On startup the process prints the relay's full multiaddrs (including the peer
id). Copy one into the browser apps' `RELAY_MULTIADDR` constant — they share
the same value.

## What it does

- Listens on a plain WebSocket address (`ws://127.0.0.1:<port>`).
  Browsers permit insecure WS to `localhost`, so no TLS is needed.
- Serves the libp2p Circuit Relay v2 protocol so two browser peers can find
  each other and exchange their ICE candidates.
- After the WebRTC upgrade, **HTTP bytes flow directly between the browser
  peers** — they do not pass through the relay.

## What it does NOT do

- No TLS / WSS. **Production deployments would need WSS** (and a stable
  hostname + cert). This is a localhost-only demo.
- No auth, no rate-limiting, no persistence.
- It is not an HTTP server, not a CDN, not a STUN/TURN server.

## Lifecycle

`Ctrl-C` (SIGINT) or SIGTERM triggers a graceful stop. Re-run `pnpm start` to
get a fresh peer id — the multiaddr changes each time, so the browser apps'
`RELAY_MULTIADDR` needs updating on restart.
