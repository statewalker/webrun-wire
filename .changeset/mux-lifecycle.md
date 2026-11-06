---
"@statewalker/webrun-rpc": minor
---

`multiplexPort` frees its ports when their transport or their user is done, and a full table says who holds it.

- `signal` option on `multiplexPort` / `overPipe`: aborting it closes the mux with `signal.reason`, so every port's close signal aborts and calls in flight reject instead of hanging.
- `close(reason?)`: the reason becomes every port's close-signal reason.
- `openPort(meta, { signal })` closes the port on abort; virtual ports are `Symbol.dispose`-able (`using`).
- `ports()` lists open ports (`id`, `meta`, `openedAt`, `lastActivity`), and the `maxPorts` `RangeError` names the commonest `meta.kind`s.
