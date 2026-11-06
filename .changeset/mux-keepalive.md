---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": minor
---

`multiplexPort` / `overPipe` take `keepalive: { intervalMs, misses? }`, off by default. The mux pings the peer every `intervalMs`; the peer answers, and anything it sends counts. After `misses` (default 3) silent intervals from a peer that has answered before, the mux closes with `webrun-rpc: the peer did not answer …`, catching a realm that died, froze or stopped reading. A peer without keepalive is never closed for it. New `ping` / `pong` envelopes, accepted by `structuredCodec` and `msgpackCodec`.
