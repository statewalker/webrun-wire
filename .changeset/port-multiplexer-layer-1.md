---
"@statewalker/webrun-streams": minor
---

A port multiplexer, in the package that already defines its central type.

`multiplexPort` turns one `MessageTarget` into many virtual ones, with explicit
`open`/`close` lifecycle and an accept callback. Virtual ports are themselves
`MessageTarget`s, so the multiplexer composes and a real `MessagePort` is
substitutable for a virtual one.

Layer 1 has no flow control by design — no backpressure, acknowledgements,
credit or buffering ceiling — and a message for a port with no consumer is
dropped rather than queued, so an unaccepted port cannot accumulate memory.

`structuredCodec` ships here; a byte codec belongs with `@statewalker/webrun-msgpack`,
which keeps this package's zero runtime dependencies intact.
