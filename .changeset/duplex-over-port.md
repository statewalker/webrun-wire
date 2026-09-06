---
"@statewalker/webrun-rpc": minor
---

Adds the stream tier and a second port multiplexer.

`duplexOverPort(port, options)` runs one `Duplex` over one port, and
`serveDuplexOverPort(port, handler, options)` is its serving half. Each
direction is one `callPort` per chunk on its own channel; the reply is the
confirmation and it is withheld until the consumer has pulled past the value,
so a producer can never run more than one chunk ahead. Memory is bounded by
construction rather than by a configured ceiling: at most one chunk per open
port. A peer that sends a second unconfirmed chunk has its call refused and
that port closed, leaving every other port untouched.

The stream carries the timeout, and it defaults to **none**. `callPort` gains
`NO_TIMEOUT` for the same reason: a per-chunk deadline fails a slow consumer,
which is a bug, not a policy. The regression test is a consumer 1200 ms per
chunk completing a transfer.

`transferPortMux(target, options)` is a second `PortMux` whose ports are real
transferred `MessagePort`s — one `MessageChannel` per `openPort`, one end
handed to the peer. It needs structured clone with transferables, so it works
in browsers, workers and iframes and not over byte transports; the caller picks
it explicitly. Unlike an emulated port, a transferred one can cross a boundary
and be used by code that never saw the parent port.

Nothing is removed. `emulateMux`, `connect`/`serve` and the existing
conformance run are unchanged, and the new stack is proven by a **second**
conformance run over the same unmodified L0–L6 suite.
