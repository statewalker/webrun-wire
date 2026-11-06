# @statewalker/webrun-msgpack

## 0.7.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-rpc crosses a breaking line

### Patch Changes

- 65570e4: Depends on `@statewalker/webrun-rpc` 0.7.1.
- Updated dependencies [eec24c8]
- Updated dependencies [cf94377]
  - @statewalker/webrun-rpc@0.8.0

## 0.6.0

### Minor Changes

- ec33737: `multiplexPort` / `overPipe` take `keepalive: { intervalMs, misses? }`, off by default. The mux pings the peer every `intervalMs`; the peer answers, and anything it sends counts. After `misses` (default 3) unanswered pings in a row from a peer that has answered before, the mux closes with `webrun-rpc: the peer did not answer …`, catching a realm that died or froze. Ticks while this end's own pipe reports a backlog are not counted. Every current mux answers pings, so one end is enough; an older peer is never closed for it. New `ping` / `pong` envelopes on an id no port takes (`Number.MAX_SAFE_INTEGER`), accepted by `structuredCodec` and `msgpackCodec`.

### Patch Changes

- Updated dependencies [ec33737]
- Updated dependencies [626599d]
  - @statewalker/webrun-rpc@0.7.0

## 0.5.0

### Minor Changes

- de98774: `msgpackCodec` implements `PortCodec`'s `encode` / `decode`, so a windowed port counts exact wire bytes, and it carries the new `credit` and `frame` envelopes. Requires `@statewalker/webrun-rpc` ^0.6.0.
- f98d2c4: Fair framing for `multiplexPort` / `overPipe`, off unless `frameSize` (bytes) is set; it needs `window`.
  
  - Every port's messages leave in turn, one per port, whenever the pipe has room, and a message larger than `frameSize` goes as `frame` envelopes the peer reassembles. A small message on one port no longer waits behind a large one on another.
  - `MessageTarget` may implement `whenDrained()` / `bufferedAmount` to say when it is full; framing waits on it between frames.
  - Frames go only on a windowed port whose two ends agreed exact sizes (`exact: true`); older peers get whole messages. Frames anywhere else are dropped.
  - `frameSize` must be a positive integer; anything else is a `RangeError`.
  - With `frameSize`, a port without a window posts at once; a `whenDrained()` that rejects closes the mux with its error; `mux.close()` still posts the close of a port whose close was queued behind its frames.
- 76c3b6d: Per-port flow control for `multiplexPort` / `overPipe`, off unless `window` (bytes) is set.
  
  - Each port has at most `window` bytes delivered to the other side and not yet consumed, in both directions, so a slow consumer holds its own port's budget and no other port's. What exceeds it waits in the port's send queue; `portBufferedAmount(port)` and `whenPortReady(port, below)` let senders wait. `whenPortReady` always resolves on a later task.
  - A message counts as consumed when its listeners return, or their promises settle. Credit goes back in batched `credit` envelopes.
  - Safe against older peers: neither end holds back until the other has shown it reads credit — the responder's zero-byte `credit` ack proves it to the opener, and the opener's answer to that ack proves it to the responder. A peer that never answers credit keeps running without flow control.
  - `PortCodec` may implement `encode(envelope)` / `decode(data)` so the window counts exact wire bytes; `msgpackCodec` does, and accepts the `credit` envelope.
  - `mux.ports()` reports a windowed port's `window` (once in force), `queued`, `outstanding` and `unconsumed` bytes.

### Patch Changes

- Updated dependencies [30d2cff]
- Updated dependencies [f98d2c4]
- Updated dependencies [76c3b6d]
  - @statewalker/webrun-rpc@0.6.0

## 0.4.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-rpc ^0.5.0 -> ^0.5.1

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-rpc crosses a breaking line

### Patch Changes

- Updated dependencies [ba6ae47]
  - @statewalker/webrun-rpc@0.5.0

## 0.3.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-rpc@0.4.3

## 0.3.0

### Minor Changes

- c054428: Carries its own MessagePack implementation and drops the `@ygoe/msgpack` dependency; the bundle
  now imports nothing.

  `src/msgpack-core.ts` is a TypeScript port of Yves Goergen's
  [msgpack.js](https://github.com/ygoe/msgpack.js) (MIT), taken from `master` (commit `05733cf`)
  rather than npm 1.0.3. It is exported as `serialize` / `deserialize` with the types
  `SerializeOptions`, `DeserializeOptions`, `MsgpackInput` and `MsgpackExtension`.

  Wire and behaviour changes, each found by a conformance test adopted from msgpack-test-suite,
  msgpack-javascript or msgpackr:

  - An integer beyond ±2⁵³ is written as a float 64. 1.0.3 wrote `2 ** 100` as the maximal uint 64,
    which read back as ~1.8e19. Integers above uint 32 now use the uint 64 prefix, and 16–255-byte
    `bin` values the one-byte bin 8 header (both from upstream `master`).
  - Truncated input throws a `RangeError` instead of decoding to `NaN` or a shortened `bin`, and
    nothing is logged. `msgpackCodec` now drops a frame cut inside its payload rather than
    delivering it short.
  - Timestamps are floored to the millisecond in both directions, before and after 1970; an invalid
    `Date` throws.
  - Strings are decoded and encoded per the WHATWG Encoding standard: malformed UTF-8 (overlong
    forms included) becomes U+FFFD, and a lone surrogate is written as U+FFFD.
  - A `__proto__` map key is decoded as an own property instead of replacing the prototype, and only
    own enumerable keys are written. `msgpackCodec` refuses an envelope whose fields arrive only
    through a prototype.

  The four stream functions also accept synchronous iterables:
  `encodeMsgpack<T>(input: Iterable<T> | AsyncIterable<T>)`,
  `decodeMsgpack<T>(input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>)`,
  `encodeFloat32Arrays(input: Iterable<Float32Array> | AsyncIterable<Float32Array>)`,
  `decodeFloat32Arrays(input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>)`.

## 0.2.2

### Patch Changes

- Updated dependencies [fbaee6a]
  - @statewalker/webrun-rpc@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [0e435d6]
  - @statewalker/webrun-rpc@0.3.0

## 0.2.0

### Minor Changes

- 97a0595: Adds `msgpackCodec`, a `PortCodec` for transports that carry bytes.

  `@statewalker/webrun-rpc`'s `multiplexPort` needs a codec to put its envelopes
  on the wire. `structuredCodec` passes them through unencoded, which works only
  where messages are structured values — a `MessagePort`, a worker, an iframe.
  `msgpackCodec` is the byte-transport sibling: one envelope becomes one msgpack
  frame and one `postMessage`. There is no length prefix, because every transport
  it targets preserves message boundaries; this package's existing
  `encodeMsgpack`/`decodeMsgpack` remain the length-prefixed _stream_ codec for
  transports that do not.

  Malformed input is dropped rather than thrown, so a peer cannot take down the
  multiplexer with a bad frame. The transfer list is ignored: after encoding, the
  payload is inside the bytes.

  One thing to get right on a capped transport: `maxMessageSize` bounds the
  _payload_, not the frame — the envelope and this codec's framing are added on
  top afterwards, measured at 123–128 bytes. **Set `maxMessageSize` to your
  transport's hard limit minus 256**, because a transport that silently drops an
  oversized message (LiveKit does) delivers the body as zero bytes with no error
  on either side.

  The dependency on `@statewalker/webrun-rpc` is type-only — it supplies the
  `PortCodec` interface and no runtime code, so `webrun-rpc` gains no msgpack
  dependency in either direction.

  One asymmetry with `structuredCodec`, documented in the README: msgpack drops
  object keys whose value is explicitly `undefined`, where structured clone keeps
  them. Nothing the RPC layer sends depends on the difference.

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [3c0f98a]
- Updated dependencies [c6dc18d]
- Updated dependencies [4f958b9]
  - @statewalker/webrun-rpc@0.2.0

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
