---
"@statewalker/webrun-msgpack": minor
---

`msgpackCodec` implements `PortCodec`'s `encode` / `decode`, so a windowed port counts exact wire bytes, and it carries the new `credit` and `frame` envelopes. Requires `@statewalker/webrun-rpc` ^0.6.0.
