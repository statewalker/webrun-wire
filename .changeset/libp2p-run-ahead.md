---
"@statewalker/webrun-streams-libp2p": minor
---

`connect` / `serve` bound run-ahead past a stalled consumer: the inbound side reads through a
queue that pauses the stream past `readHighWaterBytes` (default 64 KiB; yamux then withholds
window updates), and `serve` waits for the handler to read its input queue down before reading
more. Run-ahead is the receiving node's yamux window plus about 128 KiB (1.06 MiB measured with
`streamOptions.maxStreamWindowSize: 1 MiB`). A paused stream raises `maxReadBufferLength` to its
window so yamux's default 16 MiB window no longer kills a slow consumer's stream. New option
`readHighWaterBytes` on `connect`, `serve` and `serveConnections`.
