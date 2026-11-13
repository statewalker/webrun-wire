---
"@statewalker/webrun-streams-libp2p": minor
---

`connect` / `serve` bound run-ahead past a stalled consumer: the inbound side reads through a
queue that pauses the stream past `readHighWaterBytes` (default 64 KiB; yamux then withholds
window updates), and `serve` waits for the handler to read its input queue down before reading
more (input a handler never started to read is dropped once its output ended). Run-ahead is at
most two of the receiving node's yamux windows plus about 256 KiB (2.00 MiB measured with
`streamOptions.maxStreamWindowSize: 1 MiB`). A paused stream raises `maxReadBufferLength` to its
window so yamux's default 16 MiB window no longer kills a slow consumer's stream; muxers that do
not expose a window are read as before. New option
`readHighWaterBytes` on `connect`, `serve` and `serveConnections`.
