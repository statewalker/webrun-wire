---
"@statewalker/webrun-rpc": minor
---

`serveMethods(port, impl, { channelName, methods, timeout })` and `methodsClient<T>(port, { channelName, methods, timeout })`: serve an object's listed methods over any `MessageTarget` and call them from the other end. Plain values cross, `Uint8Array` included (structured clone over a `MessagePort`, msgpack over a byte pipe through `overPipe(pipe, { codec: msgpackCodec })`). Unlisted names are refused (`ENOSYS`); a thrown error reaches the caller with its `name`, `message` and `code`, and without the server's stack.
