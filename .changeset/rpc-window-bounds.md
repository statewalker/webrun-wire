---
"@statewalker/webrun-rpc": patch
---

Two window fixes in `multiplexPort`:

- The responder now clamps the window an opener asks for to its own (`window`) also when the opener does not list the `"window"` capability (an older or hostile peer), instead of granting whatever it asked (#202). Such a port now counts in the adaptive budget too. The ack carries no window for such an opener, as before; an honest older opener that asks for more than the responder's window, and really fills more than that before its credit returns, has its port failed by the responder's checks. One that asks for no more runs as before.
- A windowed port no longer stalls for ever over a transport that drops keys whose value is `undefined` (a msgpack round trip does) (#203). Under `structuredCodec` both ends size messages with `estimateMessageSize`, which counts every key; the receiver of a key-dropping transport credited back less than the sender counted. A windowed port now sends payloads without `undefined`-valued keys in plain objects within the estimate's reach, so both transports deliver, and both ends count, the same value whatever their versions. Reading such a key still gives `undefined`; only `"key" in payload` differs. A sender of 0.15.1 or earlier still stalls over such a transport: upgrade the sending end.
