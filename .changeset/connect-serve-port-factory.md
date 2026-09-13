---
"@statewalker/webrun-rpc": minor
---

`connect`/`serve` take a port FACTORY, not a port.

They used to take one `MessageTarget` plus `side` and build an id table inside
themselves, which forced a single multiplexing strategy on every transport.
That is correct where the transport gives you exactly one channel — a
`MessagePort`, a WebSocket — and wrong everywhere else. A libp2p connection
multiplexes already, so running the id table inside it stacked two
multiplexers with no way to tell which one stalled; a transferable boundary
moves real ports and needs no table at all.

```ts
// before
await serve({ port: channel.port2, side: "responder" }, handler);

// after
await serve({ mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) }, handler);
```

`PortMux` was already the seam for this — `openPort()` outbound, `onPort`
inbound, `maxMessageSize` reported — so the change is mostly deletion:
`connect`/`serve` now ask a factory for one port per call and run
`duplexOverPort` on it. Three options leave the API with the table they
described:

- **`side`** is `multiplexPort`'s id parity and moves to `overPipe`. A caller
  over a self-multiplexing transport has no ids and no parity, and the old
  signature made them pass one anyway.
- **`maxPorts`** bounds an id table that may not exist; it moves to `overPipe`.
- **`maxMessageSize`** stops being a parameter and becomes something the mux
  **reports**. A libp2p stream has no message ceiling and splits nothing; a
  LiveKit data channel has one. Neither is the consumer's to know.

`timeout` stays on `connect`/`serve`, because it is about the stream rather
than the transport.

**Why a factory and not a `PortMux` you hand over already built.** Every mux
decides accept-or-reject *synchronously*, inside the `open` envelope, and tells
the peer on the spot — `multiplexPort` posts `{type:"close", reason:"rejected"}`
before returning. There is no "decide later", and layer 1 refuses to queue what
it cannot deliver. A mux handed over already built therefore has a window
between its construction and its handler being attached, and a port arriving in
that window is rejected outright: measured, zero messages delivered, with the
peer told `rejected` for a call whose only fault was being early. A factory
closes the window by construction — the mux cannot exist before the thing that
answers it. Both halves are measured in `port-factory-no-race.test.ts`.

`connect` passes no handler, which is how a caller declines inbound ports; the
factory receives `undefined`. Whichever of the two called it owns the mux and
closes it.

Two factories ship: `overPipe(pipe, { codec, side?, maxPorts?, maxMessageSize? })`
for one pipe of bytes, and `overPorts(factory)` as a pass-through so an adapter
can supply its own `PortMux` without this package learning what that transport
is.

Validated against libp2p outside this repository before the change was made:
the same consumer runs over a `MessagePort` with an id table and over a libp2p
connection without one, and on libp2p each call is exactly one stream.
