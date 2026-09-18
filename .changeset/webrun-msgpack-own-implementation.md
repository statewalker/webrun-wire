---
"@statewalker/webrun-msgpack": minor
---

Carries its own MessagePack implementation and drops the `@ygoe/msgpack` dependency; the bundle
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
