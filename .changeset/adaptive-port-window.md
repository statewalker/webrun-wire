---
"@statewalker/webrun-rpc": minor
---

`multiplexPort` (and `overPipe`): a port's window can adapt after the ack (#188). `window` now
takes `{ initial, min?, max, budget? }` or `"auto"` (`DEFAULT_AUTO_WINDOW`: initial 256 KiB, min
64 KiB, max 16 MiB, budget 64 MiB) besides a number. The receiving end of each direction sizes the
window it grants to about one bandwidth-delay product from round trips it measures alone (grow
while the port fills its window at a near-minimum round trip, every growth judged by the rate it
brings; shrink when the round trip inflates; drain to the floor now and then to re-measure), and
announces it in its credits (`{ type: "credit", id, bytes, window }`). It never grants more than
`max` per port or `budget` per mux, never less than `min` or the window agreed for the port, and a
peer's port starts at `initial` whatever it asks for. A smaller window never refuses bytes sent
under the larger one: the receiver never moves the window's right edge back. A plain number keeps
the fixed window as before; a peer of 0.14 or earlier ignores the announced window and keeps the
agreed one. `PortInfo` gains `sendWindow`, the window the peer grants this end; `window` is the one
this end grants.
