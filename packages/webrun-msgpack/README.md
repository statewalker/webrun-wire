# @statewalker/webrun-msgpack

## What it is

MessagePack for the wire, in two shapes. A **stream codec** (`encodeMsgpack` / `decodeMsgpack`,
plus `Float32Array` variants) turns an iterable of values into length-prefixed frames and back, for
a transport with no message boundaries. A **message codec** (`msgpackCodec`) is a `PortCodec` for
`@statewalker/webrun-rpc`'s `multiplexPort`: one envelope becomes one bare MessagePack document and
one `postMessage`, for a transport that already frames. Both sit on the package's own MessagePack
implementation, `serialize` / `deserialize`, a TypeScript port of Yves Goergen's
[msgpack.js](https://github.com/ygoe/msgpack.js), which is exported too.

## Why it exists

A raw MessagePack stream has no frame boundaries. A decoder fed a byte stream only succeeds if the
chunk boundaries happen to line up with the document boundaries. Code that pipes values across a
transport — a scanner writing chunks to a store, a pipeline streaming embeddings — needs to
serialise a stream of objects into bytes and get exactly those objects back on the other side,
without truncation surprises. The stream codec does that with a length prefix.

`multiplexPort` runs many virtual ports over one transport and needs a codec to put its envelopes
on the wire. `structuredCodec` (in `webrun-rpc`) passes envelopes through unencoded, which only
works where messages are structured values: a `MessagePort`, a worker, an iframe. `msgpackCodec`
is the codec for transports whose messages are bytes.

The package carries its own MessagePack implementation so that its bundle imports nothing at
runtime, and so that its behaviour on truncated or hostile input is defined by tests in this
package (see [Internals](#internals)).

## How to use

```sh
pnpm add @statewalker/webrun-msgpack
```

No peer dependencies. ESM only. One entry point, `.`, which works in browsers, Node, Deno, Bun and
workers; the runtime needs `TextDecoder`.

`@statewalker/webrun-rpc` is a declared dependency but is used for **types only** (`PortCodec`,
`PortEnvelope`): `dist/index.js` imports nothing. The install still pulls `webrun-rpc` and,
through it, `@statewalker/webrun-streams` into `node_modules`, even if you use only the stream
codec or `serialize` / `deserialize`.

### Pick the codec by the transport

| | `encodeMsgpack` / `decodeMsgpack` | `msgpackCodec` |
| --- | --- | --- |
| Kind | stream codec | message codec (`PortCodec`) |
| Shape | `Iterable<T> \| AsyncIterable<T>` ⇄ `AsyncGenerator<Uint8Array>` | one `PortEnvelope` ⇄ one `postMessage` |
| Framing | 4-byte big-endian length prefix, added here | none: the transport's message boundaries are the framing |
| Use it when | the transport is a byte stream: a TCP-like socket, a `ReadableStream`, a file | the transport preserves message boundaries: a WebSocket, an `RTCDataChannel`, a LiveKit data packet |
| Malformed input | a truncated trailing frame is never emitted; the iteration just ends | dropped, never thrown |

A length prefix on a transport that already frames is redundant. Relying on message boundaries
where there are none is the truncation bug the stream codec exists to prevent.

### Exports

| Export | Direction | Use |
| --- | --- | --- |
| `encodeMsgpack<T>(input: Iterable<T> \| AsyncIterable<T>)` | values → frames | generic JSON-like values |
| `decodeMsgpack<T>(input: Iterable<Uint8Array> \| AsyncIterable<Uint8Array>)` | frames → values | inverse of `encodeMsgpack` |
| `encodeFloat32Arrays(input: Iterable<Float32Array> \| AsyncIterable<Float32Array>)` | arrays → frames | float vectors, no per-element conversion |
| `decodeFloat32Arrays(input: Iterable<Uint8Array> \| AsyncIterable<Uint8Array>)` | frames → arrays | inverse of `encodeFloat32Arrays` |
| `msgpackCodec: PortCodec` | envelope ⇄ one message | `multiplexPort` over a byte transport |
| `serialize(value, options?)` | one value → one MessagePack document | the format itself, no framing |
| `deserialize(bytes, options?)` | one document → one value | inverse of `serialize` |

Types: `SerializeOptions` (`multiple?: boolean`, `invalidTypeReplacement?: unknown`),
`DeserializeOptions` (`multiple?: boolean`), `MsgpackInput` (`Uint8Array | ArrayBuffer |
ArrayLike<number>`) and `MsgpackExtension` (`{ type: number; data: Uint8Array }`, an extension
value other than a timestamp).

The four stream functions accept synchronous iterables too, so an array needs no async wrapper.

## Examples

### One value, no framing

```ts
import { deserialize, serialize } from "@statewalker/webrun-msgpack";

const bytes = serialize({ id: 7, tags: ["a", "b"], at: new Date(0), raw: new Uint8Array([1, 2]) });
const value = deserialize(bytes); // same shape; `at` is a Date, `raw` a Uint8Array

// Several documents back to back:
const three = serialize([1, "two", { three: 3 }], { multiple: true });
deserialize(three, { multiple: true }); // [1, "two", { three: 3 }]

// A value that cannot be encoded, replaced instead of throwing:
serialize({ f: () => 1 }, { invalidTypeReplacement: "unsupported" }); // encodes { f: "unsupported" }
```

### A stream of values

```ts
import { decodeMsgpack, encodeMsgpack } from "@statewalker/webrun-msgpack";

async function* events() {
  yield { type: "start" };
  yield { type: "chunk", text: "hello" };
  yield { type: "done" };
}

const bytes: AsyncIterable<Uint8Array> = encodeMsgpack(events());

// The decoder handles arbitrary chunk boundaries.
for await (const msg of decodeMsgpack<{ type: string; text?: string }>(bytes)) {
  console.log(msg);
}
```

### Re-framing across arbitrary chunks

```ts
import { decodeMsgpack, encodeMsgpack } from "@statewalker/webrun-msgpack";

const frames: Uint8Array[] = [];
for await (const f of encodeMsgpack([{ a: 1, b: "hi" }])) frames.push(f);

// Feed the decoder one byte at a time; it buffers until a frame is complete.
const oneByteAtATime = frames.flatMap((f) => [...f].map((byte) => new Uint8Array([byte])));
for await (const v of decodeMsgpack<{ a: number; b: string }>(oneByteAtATime)) {
  console.log(v); // { a: 1, b: "hi" }
}
```

### Float32 vectors

```ts
import { decodeFloat32Arrays, encodeFloat32Arrays } from "@statewalker/webrun-msgpack";

async function* chunks() {
  yield new Float32Array([0.1, 0.2, 0.3, 0.4]);
  yield new Float32Array([0.5, 0.6, 0.7, 0.8]);
}

// Each array travels as a msgpack `bin`, reinterpreted byte for byte as Float32 on arrival.
for await (const arr of decodeFloat32Arrays(encodeFloat32Arrays(chunks()))) {
  console.log(arr.length); // 4, 4
}
```

### An RPC stream over a byte transport

`msgpackCodec` on both ends of a transport that carries `Uint8Array`s. The in-process pipe below
stands in for a WebSocket pair, an `RTCDataChannel` or a LiveKit packet stream.

```js
import { duplexOverPort, multiplexPort, serveDuplexOverPort } from "@statewalker/webrun-rpc";
import { msgpackCodec } from "@statewalker/webrun-msgpack";

// A byte transport: two ends that carry `Uint8Array`s and nothing else.
function bytePipePair() {
  const listeners = [new Set(), new Set()];
  const make = (self) => ({
    postMessage(bytes) {
      const copy = bytes.slice(); // a real transport does not share the sender's buffer
      setTimeout(() => {
        for (const listener of [...listeners[1 - self]]) listener({ data: copy });
      }, 0);
    },
    addEventListener: (_type, listener) => listeners[self].add(listener),
    removeEventListener: (_type, listener) => listeners[self].delete(listener),
  });
  return { a: make(0), b: make(1) };
}

const pipe = bytePipePair();

// The responder: every virtual port the peer opens gets an echo handler.
const server = multiplexPort(pipe.b, {
  codec: msgpackCodec,
  side: "responder",
  onPort: (port) => {
    serveDuplexOverPort(port, async function* (input) {
      for await (const chunk of input) yield chunk;
    });
  },
});

// The initiator: one virtual port, one duplex round trip over it.
const client = multiplexPort(pipe.a, { codec: msgpackCodec, side: "initiator" });
const port = await client.openPort({ kind: "stream" });
const call = duplexOverPort(port, { maxMessageSize: client.maxMessageSize });

async function* body() {
  yield new TextEncoder().encode("hello ");
  yield new TextEncoder().encode("bytes");
}

const decoder = new TextDecoder();
let echoed = "";
for await (const chunk of call(body())) echoed += decoder.decode(chunk);
console.log(echoed); // "hello bytes"

await client.close();
await server.close();
```

The same stack passes the unmodified `@statewalker/webrun-streams-conformance` L0–L6 suite over a
byte pipe, both unlimited and with frames capped at 64 KiB (`tests/conformance-bytes.test.ts`).
Read that narrowly: an in-process pipe covers this codec's own contract, including chunking. It
covers none of what a real transport adds — message-size ceilings and what happens past them,
backpressure, reconnection, close codes. Each real transport needs its own run.

## Internals

### `maxMessageSize` bounds the payload, not the frame

**Set `maxMessageSize` at least 256 bytes below the transport's hard limit.** `duplexOverPort`
splits the *payload* to `maxMessageSize`. The framing — the chunk wrapper, `callPort`'s
`{type, channelName, callId, params}`, the mux's `{type, id, payload}`, then this codec — is added
on top afterwards. Over `msgpackCodec` that overhead is `87 + len(callId)` bytes and it is not
constant: `callId` is `` `call-${Date.now()}-${String(Math.random()).substring(2)}` ``, 31–40
characters per chunk because `Math.random()` drops trailing zeros; the port id's integer width adds
0–4; the channel name `"out"` adds 1 over `"in"`; a chunk of 64 KiB or more adds 2 as the `bin`
header widens. Summing the terms gives a modelled ceiling of 134 bytes. The overheads actually
observed span 123–128 bytes.

Measured with a 512 KiB body through the stack in the example above:

| `maxMessageSize` | intent | largest frame posted | overhead |
| --- | --- | --- | --- |
| `16 * 1024` | an `RTCDataChannel`'s conservative ceiling | 16,508 bytes | 124 |
| `12 * 1024` | LiveKit's safe packet size | 12,413 bytes | 125 |
| `64 * 1024` | | 65,662 bytes | 126 |

The 128-byte maximum came from a 64 KiB cap in the capped conformance run (a 65,664-byte frame over
a 10 MiB body). Setting `maxMessageSize` to the transport's hard limit overruns it on the first
full-size chunk, and a transport that silently drops oversized messages gives no signal. On LiveKit
the body arrives as zero bytes with no error on either side. `limit - 256` covers every measured
case with room to spare.

### Two ways `msgpackCodec` differs from `structuredCodec`

**The transfer list is ignored.** `PortCodec.post` receives an optional `Transferable[]`;
`msgpackCodec` drops it. After encoding, the payload is inside the bytes, so there is nothing left
to hand over, and transferring the caller's buffers would detach buffers the caller still owns.

**Object keys whose value is `undefined` are dropped**; structured clone keeps them.
`{ result: undefined }` arrives as `{}`. Nothing `webrun-rpc`'s stream and RPC layers send depends
on the difference: every wire shape they produce is pinned against both codecs in
`tests/codec-equivalence.test.ts`. A payload where `"key" in obj` means something different from
`obj.key === undefined` will not survive this codec.

One edge: `webrun-streams`' `serializeError` copies every own enumerable property of a thrown
`Error` onto the wire. A `cause` holding a `Map` or a class instance collapses to `{}`, and a
circular reference makes `serialize` throw.

### What `msgpackCodec.read` accepts, and why it never throws

It accepts a `Uint8Array`, an `ArrayBuffer`, or any `ArrayBufferView` (a `DataView` included,
offset and length honoured). Everything else returns `undefined`, which the multiplexer treats as
"not ours": a non-byte value, empty bytes, malformed MessagePack, and valid MessagePack that is not
a `PortEnvelope` (`id` must be a non-negative integer, `type` one of `open` / `message` / `close`).
A shared transport may carry other traffic, and the multiplexer must not mistake it for an
envelope.

Refusal is a dropped message, never a throw. A throw here would escape inside the raw port's own
listener, outside any consumer's reach, and one hostile frame could take the multiplexer down.
`read` can still throw for three inputs, all in the byte-shape check before the `try`: a detached
`ArrayBuffer`, a `DataView` over a detached buffer, and a `Proxy` with a throwing
`getPrototypeOf`. None can arrive over a wire.

### Stream frame layout and decoder

```
┌──────────────┬────────────────────────────┐
│  uint32 BE   │    msgpack payload         │
│  (4 bytes)   │    (`length` bytes)        │
└──────────────┴────────────────────────────┘
```

Big-endian 32-bit length, so at most 2³²−1 bytes per frame. A frame is built whole: one
`serialize` call per value, no fragmentation. This layout belongs to the stream codec only;
`msgpackCodec` prefixes nothing.

The decoder keeps a rolling buffer. Each chunk is appended (one allocation per chunk), then: if
fewer than 4 bytes are buffered, wait; read the length; if `4 + length` bytes are not buffered,
wait; copy the payload out, `deserialize` it, yield; advance and repeat. Zero-length chunks are
harmless. A truncated trailing frame stays in the buffer and the iteration ends without yielding
it, so a caller detects truncation by comparing the count received with the count expected.

### Float32: no per-element conversion, but not zero-copy

`encodeFloat32Arrays` wraps the array's bytes in a `Uint8Array` view and serialises it as a `bin`.
`decodeFloat32Arrays` reinterprets the decoded bytes as a `Float32Array`, copying first when the
`byteOffset` is not 4-byte aligned. In practice the copy always happens: the decoded `bin` is a
view starting after a 2-, 3- or 5-byte header, never a multiple of 4. `serialize` and frame
assembly also copy on the way out. Element type is strictly Float32; there is no negotiation.

### Send the view `serialize` returns, not its buffer

`serialize` returns a view over an internal buffer that is not trimmed: a 10 MiB envelope measures
about 10,485,800 bytes over a 16,777,216-byte `ArrayBuffer`. A transport pump that sends
`frame.buffer` instead of `frame` puts about 6 MiB of trailing zeros on the wire per message.

### What `deserialize` refuses, and how

`deserialize` throws on input that is not MessagePack, and never logs:

- Truncated input — any read past the end — throws a `RangeError`:
  `Insufficient data: N byte(s) needed at index I in the MessagePack binary data (length L).`
  Every proper prefix of a valid encoding is refused this way.
- `Invalid byte code 0xc1 found.` for the never-used type byte.
- `Invalid argument: The byte array to deserialize is empty.` for empty input.
- `Invalid argument type: Expected a byte array (Array or Uint8Array) to deserialize.` for a
  non-byte argument.
- `Invalid data length for a date value.` for a timestamp extension of unknown size.
- Malformed UTF-8 inside a string is not an error: each bad sequence decodes to U+FFFD, as
  `TextDecoder` does. Overlong forms are malformed, so `C0 AF` does not decode to `/`.
- Bytes after the first document are ignored unless `{ multiple: true }` is passed.

`serialize` throws `Invalid argument type: The type '<type>' cannot be serialized.` for a
`bigint`, function or symbol when `invalidTypeReplacement` is not set. A falsy replacement (`null`,
`0`, `false`, `""`) counts as not set and still throws; to write nil, pass a function such as
`() => null`. It also throws `Invalid argument: an
invalid Date cannot be serialized.` for an invalid `Date`, and `Invalid argument type: Expected an
Array to serialize multiple values.` when `multiple` is set on a non-array.

`msgpackCodec` turns every `deserialize` throw into a dropped message.

### The value model

| Written | As | Read back as |
| --- | --- | --- |
| `null`, `undefined` | nil | `null`; an object key whose value is `undefined` is dropped |
| `boolean` | bool | `boolean` |
| safe integer | narrowest int / uint | `number`; `-0` is written as `0` |
| any other number (fraction, beyond ±2⁵³, `NaN`, `±Infinity`) | float 64 | `number` |
| `string` | str, UTF-8; a lone surrogate is written as U+FFFD | `string` |
| `Uint8Array`, `Uint8ClampedArray` | bin | `Uint8Array`, a view into the input, not a copy |
| other typed arrays | array of numbers | `number[]` |
| `Array` | array | `unknown[]` |
| `Date` | timestamp extension (type -1), 32/64/96-bit as needed | `Date`, floored to the millisecond |
| any other object | map of its own enumerable string keys | plain object; every key, `__proto__` included, is an own property |
| `bigint`, `function`, `symbol` | throws, unless `invalidTypeReplacement` supplies a stand-in | |

Reading also accepts what other encoders write: float 32, int 64 / uint 64 (as the nearest
`number`, losing precision beyond 2⁵³), maps with non-string keys (converted with `String()`), and
extension types other than timestamps, returned as `{ type, data }` with `type` as the unsigned
byte (type `-2` reads as `254`). A `Map` or `Set` has no own enumerable keys and is written as an
empty map.

### The MessagePack implementation is a port of msgpack.js

`src/msgpack-core.ts` is a TypeScript port of **[msgpack.js](https://github.com/ygoe/msgpack.js)**
by **Yves Goergen**, © 2019, MIT license. Thank you.

It is ported from commit
[`05733cf`](https://github.com/ygoe/msgpack.js/tree/05733cfb43a2974cf669f0eb8693f43b548bdcd4)
(2024-04-16) on `master`, not from the npm release 1.0.3, because `master` carries three fixes
that change what goes on the wire:

- [#34](https://github.com/ygoe/msgpack.js/pull/34): an integer beyond the safe range is written
  as a float 64, not as the maximal uint 64.
- [#32](https://github.com/ygoe/msgpack.js/issues/32): a positive integer above uint 32 uses the
  uint 64 prefix `0xcf`, not int 64's `0xd3`.
- [#33](https://github.com/ygoe/msgpack.js/issues/33): a 16–255-byte `bin` gets the one-byte bin 8
  header.

The port keeps upstream's structure, comments and error messages. Before any change it was checked
against upstream itself: byte-identical output for 3,000 randomised values, and the same value or
the same error message for 20,000 random garbage inputs. Each change below is marked
`Modified from upstream` in the source and was made where a test adopted from another
implementation failed:

1. Truncated input throws a `RangeError` instead of decoding to `NaN` or a short `bin`, and
   nothing is logged (upstream called `console.debug` with the whole input).
2. Timestamps are floored to the millisecond both ways. Upstream rounded `…:07.999999999Z` up to
   the next second, read pre-1970 instants toward zero, and wrote `new Date(-1002)` as second -1.
   An invalid `Date` throws.
3. Strings follow the WHATWG Encoding standard: decoding goes through `TextDecoder`, and encoding
   writes a lone surrogate as U+FFFD, where upstream threw on a high one and wrote a low one as
   invalid UTF-8.
4. A `__proto__` map key is decoded as an own property (upstream's assignment replaced the
   prototype), and only own enumerable keys are written (upstream's `for…in` also wrote inherited
   ones).
5. TypeScript types, `unknown` in place of `any`, and the bounds `0xffffffffffffffff` /
   `0x7fffffffffffffff` spelled `2 ** 64` / `2 ** 63` (the same doubles).

Besides this package's own tests, the suite runs upstream's test page ported to vitest
(`tests/msgpack-core.upstream.test.ts`);
[kawanet/msgpack-test-suite](https://github.com/kawanet/msgpack-test-suite) (MIT, © Yusuke
Kawasaki), vendored (`tests/msgpack-core.test-suite.test.ts`); and cases adopted from
[msgpack/msgpack-javascript](https://github.com/msgpack/msgpack-javascript) (ISC, © The
MessagePack Community) and [kriszyp/msgpackr](https://github.com/kriszyp/msgpackr) (MIT, © Kris
Zyp), with msgpackr's sample documents vendored (`tests/msgpack-core.adopted.test.ts`). Sources,
commits and licenses of the vendored fixtures are in
[`tests/fixtures/README.md`](./tests/fixtures/README.md). Outside the suite, the implementation was
checked for interoperability with `@msgpack/msgpack` 3.1.3 and `msgpackr` 2.1.0: 2,000 random
values encoded by each side decode identically on the other, in both directions.

### Dependencies

- Runtime: none. `dist/index.js` imports nothing.
- `@statewalker/webrun-rpc` (`dependency`, type-only): `PortCodec`, `PortEnvelope`.
- Dev only: `@statewalker/webrun-streams` and `@statewalker/webrun-streams-conformance` for the
  conformance run; TypeScript, vitest, rolldown, rimraf, Biome.

### Scripts

```sh
pnpm test              # vitest run
pnpm run build         # rolldown + tsc --emitDeclarationOnly
pnpm lint              # biome check src tests
pnpm typecheck         # tsc --noEmit
pnpm typecheck:tests   # tsc -p tsconfig.tests.json; needs the workspace packages built
```

## License

MIT © statewalker. See [LICENSE](./LICENSE), which also carries msgpack.js's MIT notice.
