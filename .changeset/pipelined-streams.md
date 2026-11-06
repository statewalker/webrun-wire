---
"@statewalker/webrun-rpc": minor
---

Pipelined streams on windowed ports. A windowed `open` now lists `caps: ["pipeline"]` and the responder's ack answers with the shared subset (only to an opener that listed some). Once `pipeline` is agreed and the window holds this end's sends, `duplexOverPort` (and so `connect` / `serve`) sends chunks as plain messages bounded by the window instead of one confirmed call per chunk. A peer that pipelines where it was not agreed, past the window plus one chunk, or mixing confirmed and pipelined chunks, fails the stream and closes the port. A chunk that is a view on a larger buffer is copied when sent and when received, so neither end ships or holds the whole buffer per chunk. Ports without a window, `transferPortMux` ports and peers that answer no capabilities behave as before.
