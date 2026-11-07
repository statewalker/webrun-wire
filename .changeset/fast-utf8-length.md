---
"@statewalker/webrun-http-browser": patch
---

A socket measures each message's UTF-8 size natively (`TextEncoder.encodeInto` into a reused buffer) instead of in a JavaScript loop over its characters. Both ends measure every message, for `bufferedAmount` and for the byte acknowledgements, and the loop took about 0.26 ms per 64 KiB string: an echo of 64 KiB messages spent about 1 ms per message counting bytes. Through cellb (a WebSocket into a loaded Worker, on Node), 64 KiB messages go from 72 to about 200 MB/s and 1 KiB messages from about 23,000 to 30,000 per second. The counts are the same as before, a lone surrogate counting as the 3 bytes of U+FFFD.
