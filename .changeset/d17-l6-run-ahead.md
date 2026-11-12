---
"@statewalker/webrun-streams-conformance": minor
---

**Breaking: L6 is redefined around run-ahead, and `PairTuning` is reshaped (spec D17).** `PairTuning` is now `{ maxMessageSize?: number }`; `mtu` and `maxStreamBuffer` described `emulateMux`'s window, which is gone. `ConnectServePair` gains an optional `runAheadBytes`: the most bytes a producer may get ahead of a consumer that stopped reading.

L6 now has three tests:
- A 256 KiB body crosses as 4 KiB messages to a slow consumer, intact.
- In each direction, a producer facing a consumer that stops after one chunk must stall within `runAheadBytes`, then finish with every byte intact once the consumer resumes.

A pair that declares no bound gets the completion check alone. Measured bounds:

| Pair | Bound |
| --- | --- |
| Loopback | 0 |
| Port stack | 0 (declared 8 KiB) |
| `-webrtc` | 4 MiB, its window |
| `-libp2p` | none: 22–24 MiB ahead until libp2p aborts the stream; recorded in its README |
