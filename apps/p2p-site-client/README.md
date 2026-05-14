# p2p-site-client

Browser app that dials a [p2p-site-server](../p2p-site-server/) peer through
the [p2p-relay](../p2p-relay/) and exposes the remote site under a local
ServiceWorker.

Two views:

1. **Iframe (transparent proxy).** A `HostedSiteBuilder` registers a SW
   that intercepts every fetch under the SW scope and forwards it via
   `fetchOverPort` to the server peer. The iframe loads `site.baseUrl`
   and renders the remote `/`; any in-iframe `fetch("/api/time")` is
   transparently proxied.

2. **Explicit SSE log.** Bypasses the SW. The "Subscribe" button calls
   `fetchOverPort(port, new Request("/api/events"), { signal })` directly,
   iterates the response body, parses standard SSE format, and appends each
   event to a `<ul>`. The "Stop" button aborts the request — the server's
   tick interval stops within ~2 seconds (consumer-side cancellation
   propagates through the port).

## Run

```sh
# 1. Start the relay
pnpm --filter @statewalker/p2p-relay start
# 2. Start the server (paste relay multiaddr where indicated):
VITE_RELAY_MULTIADDR="/ip4/127.0.0.1/tcp/9090/ws/p2p/<peerId>" pnpm --filter @statewalker/p2p-site-server dev
# 3. Start the client:
VITE_RELAY_MULTIADDR="/ip4/127.0.0.1/tcp/9090/ws/p2p/<peerId>" pnpm --filter @statewalker/p2p-site-client dev
```

Dev server runs on `http://localhost:5176`. The relay multiaddr **must**
match between client and server — both peers need to know the same
rendezvous.

## How to obtain the server peer id

Open the [p2p-site-server](../p2p-site-server/) tab; the "peer id" field
shows it. Click the copy button, paste into the client's `server peer id`
input, then click `Connect`.

## What each view exercises

| view        | path                          | exercises                                   |
| ----------- | ----------------------------- | ------------------------------------------- |
| iframe HTML | server's `GET /`              | SW intercept + envelope round-trip          |
| iframe JS   | iframe-internal `/api/time`   | SW intercept of in-page `fetch`             |
| SSE log     | outer-page `/api/events`      | streaming response body, consumer cancel    |

## Troubleshooting

- **`Connect` fails immediately** — the server peer id may be stale (server
  was reloaded). Re-copy from the server tab.
- **Iframe is blank** — SW failed to register or intercept. Open dev tools
  → Application → Service Workers. The SW must be `activated` and scoped
  to `/`.
- **SSE log freezes at `(error: ...)`** — likely a bug; check the network /
  console panes for the underlying libp2p stream error.
