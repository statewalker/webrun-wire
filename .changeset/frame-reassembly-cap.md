---
"@statewalker/webrun-rpc": minor
---

`multiplexPort` bounds what it holds of messages reassembled from a peer's frames (`frameSize`):

- **Window:** a partial message counts against its port's window as it arrives. One begun while this side still owed credit must fit what the window left.
- **Cap:** all partial messages together, across ports, hold at most the new `maxReassembledBytes` option (default `DEFAULT_MAX_REASSEMBLED_BYTES`, 64 MiB; also on `overPipe`).

Past either limit, the partial message is dropped, the port closes with a `RangeError`, and the peer gets a `close` with reason `"max-reassembled-bytes"`. A peer that sends frames that never end can no longer make this side hold every byte.

Behaviour change: a framed message larger than the receiver's `maxReassembledBytes` used to arrive, and now closes the port. Raise the cap on the receiving side if a peer frames larger messages. A port that closes with messages still queued now sends them whole rather than framed.
