---
"@statewalker/webrun-rpc": minor
---

`multiplexPort` bounds a message it reassembles from a peer's frames (`frameSize`). Frames count against the port's window as they arrive, and a message larger than the window, which an honest peer starts only when nothing is owed back, may grow up to the new `maxReassembledBytes` option (default `DEFAULT_MAX_REASSEMBLED_BYTES`, 64 MiB; also on `overPipe`). Past either limit the partial message is dropped, the port closes with a `RangeError`, and the peer gets a `close` with reason `"max-reassembled-bytes"`. A peer sending frames that never end can no longer make this side hold every byte.
