---
"@statewalker/webrun-msgpack": minor
---

Adds `msgpackCodec`, a `PortCodec` for transports that carry bytes.

`@statewalker/webrun-rpc`'s `multiplexPort` needs a codec to put its envelopes
on the wire. `structuredCodec` passes them through unencoded, which works only
where messages are structured values — a `MessagePort`, a worker, an iframe.
`msgpackCodec` is the byte-transport sibling: one envelope becomes one msgpack
frame and one `postMessage`. There is no length prefix, because every transport
it targets preserves message boundaries; this package's existing
`encodeMsgpack`/`decodeMsgpack` remain the length-prefixed *stream* codec for
transports that do not.

Malformed input is dropped rather than thrown, so a peer cannot take down the
multiplexer with a bad frame. The transfer list is ignored: after encoding, the
payload is inside the bytes.

The dependency on `@statewalker/webrun-rpc` is type-only — it supplies the
`PortCodec` interface and no runtime code, so `webrun-rpc` gains no msgpack
dependency in either direction.

One asymmetry with `structuredCodec`, documented in the README: msgpack drops
object keys whose value is explicitly `undefined`, where structured clone keeps
them. Nothing the RPC layer sends depends on the difference.
