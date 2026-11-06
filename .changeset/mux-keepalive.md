---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": minor
---

`multiplexPort` / `overPipe` take `keepalive: { intervalMs, misses? }`, off by default. The mux pings the peer every `intervalMs`; the peer answers, and anything it sends counts. After `misses` (default 3) unanswered pings in a row from a peer that has answered before, the mux closes with `webrun-rpc: the peer did not answer …`, catching a realm that died or froze. Ticks while this end's own pipe reports a backlog are not counted. Every current mux answers pings, so one end is enough; an older peer is never closed for it. New `ping` / `pong` envelopes on an id no port takes (`Number.MAX_SAFE_INTEGER`), accepted by `structuredCodec` and `msgpackCodec`.
