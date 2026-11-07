---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": patch
---

Half-close on windowed ports. A windowed `open` now lists `caps: ["pipeline", "end"]`, `end` only when the mux's codec declares the new optional `PortCodec.halfClose: true` (that its `read` accepts the `end` envelope); `structuredCodec` and `msgpackCodec` set it. A codec without the flag never offers or agrees `end`, so a codec that would drop the envelope cannot leave a normally finished port in the peer's table. Where both ends agree `end`, each direction of a port can end with a new `{ type: "end", id }` envelope, queued behind everything already posted on that port (a size-0 item in its window queue, so it needs no credit, and behind its frames with `frameSize`); anything posted on that side afterwards is dropped, and once both directions have ended the id is freed on both ends with no `close`, aborting the port's close signal with "the port ended in both directions". A port closed with its `end` still queued sends its `close` alone. An `end` from a peer where it was not agreed, or a `message` or `frame` after a peer's own `end`, closes the port. Nothing exported sends `end` yet.
