---
"@statewalker/webrun-streams-webrtc": minor
---

Flow control on each data channel. A sender waits while `bufferedAmount` is above 1 MiB (until `bufferedamountlow` at 256 KiB), and may have at most 1 MiB outstanding that the receiving consumer has not pulled; the receiver returns credit with a new `CREDIT` frame (0x03). A 100 MiB body no longer overflows the browser's send queue, and a slow reader stalls the sender instead of growing an unbounded queue. Wire change: both ends must run this version (an older peer never returns credit, so a newer sender stops after 1 MiB).
