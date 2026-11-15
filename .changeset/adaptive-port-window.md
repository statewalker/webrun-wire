---
"@statewalker/webrun-rpc": minor
---

`multiplexPort` (and `overPipe`): a port's window can adapt after the ack (#188). `window` now
takes `{ initial, max }` or `"auto"` (`DEFAULT_AUTO_WINDOW`, 256 KiB to 16 MiB) besides a number.
The receiving end of each direction grants a larger window while the port is limited by its
window and the round trip stays near its minimum, and a smaller one when the round trip inflates,
never more than `max` and never less than the window agreed for the port, and announces it in its
credits (`{ type: "credit", id, bytes, window }`). A smaller window never refuses bytes sent under
the larger one: the receiver never moves the window's right edge back. A plain number keeps the
fixed window as before; a peer of 0.14 or earlier ignores the announced window and keeps the
agreed one. `PortInfo` gains `sendWindow`, the window the peer grants this end; `window` is the one
this end grants.
