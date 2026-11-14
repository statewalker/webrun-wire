---
"@statewalker/webrun-msgpack": minor
---

`decodeMsgpack` / `decodeFloat32Arrays`: reassembly is now linear (chunks are kept in a list and copied once per frame instead of concatenated on every chunk), and the peer-supplied frame length is bounded by a new `maxFrameBytes` option (default `DEFAULT_MAX_FRAME_BYTES`, 64 MiB). A header above it throws a `RangeError` before any payload is buffered. New exports: `DEFAULT_MAX_FRAME_BYTES`, `DecodeMsgpackOptions`.
