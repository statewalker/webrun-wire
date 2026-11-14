---
"@statewalker/webrun-http-streams": patch
---

The HTTP/1.1 decoder joins a head line once, when its LF arrives, instead of concatenating the buffer on every pull: a long header line sent in tiny frames no longer costs quadratic CPU.
