---
"@statewalker/webrun-rpc-http": patch
---

`newRpcClient` no longer caches a failed descriptor load: if the server is not reachable at the
first `loadService`, the next call fetches the descriptor again instead of rethrowing the first
error for the life of the client.
