---
"@statewalker/webrun-rpc": patch
---

A call whose port dies while the caller's input is still open (a producer waiting for something to send) now fails at once: the sending pump no longer waits for the producer's pending `next()` after the stream aborted (`throughAbort` returns at once on abort). Before, the caller's read stayed pending for ever, most often on windowed native ports, where a chunk leaves without waiting for its confirmation (statewalker/webrun-wire#153).
