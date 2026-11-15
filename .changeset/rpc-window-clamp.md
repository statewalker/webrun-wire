---
"@statewalker/webrun-rpc": minor
---

The responder bounds the window a peer's `open` asks for (#145). Windowed ports gain the `"window"` capability. Where both ends speak it, the responder holds the port to the smaller of the opener's window and its own `window` option, and names it in its ack (`{ type: "credit", bytes: 0, caps, window }`); the opener takes it, so an opener can no longer lift the responder's layer-2 bound by asking for a huge window. An ack only ever shrinks the opener's window. Ports opened later on the same mux ask for the learned window. A port presumed with `presumeAck: "always"` that sent more than the clamped window before its ack fails with reason `"protocol"`. Openers from earlier versions do not list `"window"`, so they keep the window they ask for, as before, and they keep working.
