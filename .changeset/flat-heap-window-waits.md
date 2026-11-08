---
"@statewalker/webrun-rpc": patch
---

A pipelined stream that waits on a full window no longer keeps memory per wait. Each wait raced the window against a promise for the stream's abort, which never settles on a live stream, so every wait left a reaction on it until the stream ended: with a 1 KiB window, 200,000 × 16 B chunks grew the heap by about 8 MB. Each wait now listens for the abort only while it lasts.
