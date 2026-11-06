---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": patch
---

Half-close on windowed ports. A windowed `open` now lists `caps: ["pipeline", "end"]`. Where both ends agree `end`, each direction of a port can end with a new `{ type: "end", id }` envelope, queued behind everything already posted on that port (a size-0 item in its window queue, so it needs no credit, and behind its frames with `frameSize`); anything posted on that side afterwards is dropped, and once both directions have ended the id is freed on both ends with no `close`, aborting the port's close signal with "the port ended in both directions". An `end` from a peer where it was not agreed closes the port. `structuredCodec` and `msgpackCodec` accept the `end` envelope. Nothing exported sends `end` yet.
