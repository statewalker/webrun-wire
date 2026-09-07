---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-streams": minor
"@statewalker/webrun-http-browser": patch
---

The port layer moves to `@statewalker/webrun-rpc`, renamed from
`@statewalker/webrun-streams-port`.

**Both packages are still on 0.x, where `minor` is the breaking channel, so
these are declared `minor` and land as 0.2.0 — not `major`, which changesets
would take straight to 1.0.0. The changes below are breaking regardless of the
bump level; read them as such.**

`webrun-rpc` breaks twice over: the npm package name changed, and `openPort`
is now asynchronous. It gains `MessageTarget`, `PortMux`, `multiplexPort`,
`structuredCodec` and the port envelope types, and its RPC primitives —
`callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`,
`send`, `recieve` — now accept any `MessageTarget` rather than only a
`MessagePort`.

`webrun-streams` breaks because it loses those exports. It keeps generic
stream functionality: `Duplex`, `Connect`, `Serve`, error serialisation and the
async-iterator utilities. `Duplex` deliberately stays — `webrun-http-streams`
consumes it and touches nothing port-related.

`webrun-http-browser` only repoints a one-line re-export, so it is a patch.
