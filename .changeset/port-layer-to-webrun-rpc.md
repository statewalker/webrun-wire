---
"@statewalker/webrun-rpc": major
"@statewalker/webrun-streams": major
"@statewalker/webrun-http-browser": patch
---

The port layer moves to `@statewalker/webrun-rpc`, renamed from
`@statewalker/webrun-streams-port`.

`webrun-rpc` is major twice over: the npm package name changed, and `openPort`
is now asynchronous. It gains `MessageTarget`, `PortMux`, `multiplexPort`,
`structuredCodec` and the port envelope types, and its RPC primitives —
`callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`,
`send`, `recieve` — now accept any `MessageTarget` rather than only a
`MessagePort`.

`webrun-streams` is major because it loses those exports. It keeps generic
stream functionality: `Duplex`, `Connect`, `Serve`, error serialisation and the
async-iterator utilities. `Duplex` deliberately stays — `webrun-http-streams`
consumes it and touches nothing port-related.

`webrun-http-browser` only repoints a one-line re-export, so it is a patch.
