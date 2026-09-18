# @statewalker/webrun-msgpack

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
