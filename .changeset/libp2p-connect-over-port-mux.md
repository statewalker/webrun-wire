---
"@statewalker/webrun-streams-libp2p": minor
---

`connect`/`serve`/`serveConnections` now run each call as one port of the windowed native port mux (`libp2pPortMux` with `webrun-rpc`'s port stack), the transport's only flow control (statewalker/webrun-wire#153). A call's stream negotiates `<protocol>/ports/window`; the port window defaults to 4 MiB (`DEFAULT_WINDOW`) and is set with the new `window` option on either end (at least 64 KiB; size it to at least the link's bandwidth-delay product, see the README's "Sizing the window"). New option `timeout` (per-call inactivity, off by default). New exports `DEFAULT_WINDOW` and `portProtocolOf`. `@statewalker/webrun-rpc` and `@statewalker/webrun-msgpack` become runtime dependencies.

The protocol of 0.6.0 and older (`protocol` itself) is deprecated and kept for one release on both ends: `serve` still answers old callers on it, and `connect` falls back to it when a server refuses the port protocol (remembered per peer for the connection). It is removed in the next release, with `duplexOverStream`, `DuplexOverStreamOptions`, `DEFAULT_DRAIN_TIMEOUT_MS`, `DEFAULT_CLOSE_TIMEOUT_MS` and the `drainTimeoutMs`/`readHighWaterBytes` options, all marked `@deprecated` and applying to the deprecated protocol only.

Behaviour that differs between two new ends: a call ends when the handler's output ends (input not yet sent is abandoned, and the handler's input is told so); there is no drain timeout (a stalled peer holds at most a window per call; set `timeout`); responses arrive in chunks of up to 256 KiB; failures on the serving side reach the handler and the caller instead of being logged. Stream limits stay pass-through (libp2p's defaults when unset).
