# @statewalker/webrun-msgpack

MessagePack on the wire, in **two distinct shapes**:

- a **stream codec** — `encodeMsgpack` / `decodeMsgpack`, length-prefixed, for a transport with no
  message boundaries (plus specialisations for `Float32Array`);
- a **message codec** — `msgpackCodec`, a `PortCodec` for `@statewalker/webrun-rpc`'s
  `multiplexPort`, with no length prefix, for a transport that already frames.

Both sit on the package's own MessagePack implementation, `serialize` / `deserialize`, which is
exported too. It is a TypeScript port of Yves Goergen's
[msgpack.js](https://github.com/ygoe/msgpack.js) with a handful of fixes — see
[Provenance and credits](#provenance-and-credits). The package has no runtime dependencies.

The two codecs are not interchangeable, and reaching for the wrong one is easy. The table below is
the whole decision.

## Which codec

| | `encodeMsgpack` / `decodeMsgpack` | `msgpackCodec` |
| --- | --- | --- |
| Kind | stream codec | message codec (`PortCodec`) |
| Shape | `AsyncIterable<T>` ⇄ `AsyncIterable<Uint8Array>` | one `PortEnvelope` ⇄ one `postMessage` |
| Framing | **4-byte big-endian length prefix**, added by this package | **none** — the transport's own message boundaries are the framing |
| Use it when | the transport is a byte *stream*: a TCP-like socket, a `ReadableStream`, a file, anything where chunk boundaries are arbitrary | the transport preserves *message* boundaries: a WebSocket, an `RTCDataChannel`, a LiveKit data packet |
| Malformed input | a truncated trailing frame is never emitted; the consumer ends without yielding a partial value | dropped, never thrown — a bad frame from a peer cannot take the multiplexer down |
| Depends on | nothing | **type-only** `@statewalker/webrun-rpc` |

Adding a length prefix on a transport that already frames is redundant framing; relying on message
boundaries where there are none is the truncation bug the stream codec exists to prevent. Pick by
the transport, not by taste.

## Why the stream codec exists

Consumers that pipe values across transports (scanners writing chunks to a store, chat pipelines streaming embeddings, etc.) need a way to serialise a stream of objects into a byte stream and reassemble it on the other side without truncation surprises.

A raw MessagePack stream has no frame boundaries: a decoder can only succeed if the chunk boundaries happen to line up with the payload boundaries. Length-prefix framing fixes this — the decoder buffers incoming bytes and only yields when a complete `[length][payload]` pair is available. Partial trailing frames are NEVER emitted, so callers can detect truncation by comparing observed count to expected.

Previously the codec lived inside `@repo/streams` (private, unpublished). It's been extracted here so (a) consumers that only need framing don't pull in the broader `webrun-streams` surface, and (b) MessagePack lives in exactly one place.

## Why the port codec exists

`@statewalker/webrun-rpc`'s `multiplexPort` runs many virtual ports over one transport, and it needs
a codec to put its envelopes on the wire. `structuredCodec` (in `webrun-rpc`) passes them through
unencoded, which works only where messages are *structured values* — a `MessagePort`, a worker, an
iframe. `msgpackCodec` is the byte-transport sibling: one envelope becomes one msgpack frame and one
`postMessage`.

## Install

```sh
npm install @statewalker/webrun-msgpack
```

No runtime dependencies **in the emitted bundle** — `dist/index.js` imports nothing — and no peer
dependencies. ESM only (`"type": "module"`). That is not the same as the install cost:
`@statewalker/webrun-rpc` is a declared `dependency`, so `npm install` also pulls it and,
transitively, `@statewalker/webrun-streams` into `node_modules` — even for a consumer who uses only
the stream codec or `serialize` / `deserialize`.

`@statewalker/webrun-rpc` is declared as a dependency but is **type-only**: `msgpackCodec` imports
the `PortCodec` interface from it and no runtime code, so nothing of `webrun-rpc` is in the built
bundle and `webrun-rpc` gains no msgpack dependency in either direction.

The runtime needs `TextDecoder`, which every current browser, Node, Deno and Bun provide.

## How to use

### Exports

| Export | Direction | Use case |
| --- | --- | --- |
| `encodeMsgpack<T>(src: Iterable<T> \| AsyncIterable<T>)` | values → frames | generic JSON-ish values |
| `decodeMsgpack<T>(src: Iterable<Uint8Array> \| AsyncIterable<Uint8Array>)` | frames → values | inverse of `encodeMsgpack` |
| `encodeFloat32Arrays(src: Iterable<Float32Array> \| AsyncIterable<Float32Array>)` | arrays → frames | float streaming, no per-element conversion |
| `decodeFloat32Arrays(src: Iterable<Uint8Array> \| AsyncIterable<Uint8Array>)` | frames → arrays | inverse of `encodeFloat32Arrays` |
| `msgpackCodec: PortCodec` | envelope ⇄ one framed message | `multiplexPort` over a byte transport |
| `serialize(value, options?)` | one value → one MessagePack document | the format itself, no framing |
| `deserialize(bytes, options?)` | one document → one value | inverse of `serialize` |

Types: `SerializeOptions`, `DeserializeOptions`, `MsgpackInput` (what `deserialize` accepts:
`Uint8Array`, `ArrayBuffer` or an array of byte values) and `MsgpackExtension` (an extension value
other than a timestamp: `{ type, data }`).

All four stream functions take synchronous iterables too — an array, a generator — so a fixed
list needs no async wrapper.

## Examples

### One value, no framing

```ts
import { deserialize, serialize } from "@statewalker/webrun-msgpack";

const bytes = serialize({ id: 7, tags: ["a", "b"], at: new Date(0), raw: new Uint8Array([1, 2]) });
const value = deserialize(bytes); // same shape; `at` is a Date, `raw` a Uint8Array

// Several documents back to back:
const three = serialize([1, "two", { three: 3 }], { multiple: true });
deserialize(three, { multiple: true }); // [1, "two", { three: 3 }]
```

### Stream of values

```ts
import { encodeMsgpack, decodeMsgpack } from "@statewalker/webrun-msgpack";

async function* events() {
  yield { type: "start" };
  yield { type: "chunk", text: "hello" };
  yield { type: "done" };
}

// encode
const bytes: AsyncIterable<Uint8Array> = encodeMsgpack(events());

// decode on the other side — handles arbitrary chunk boundaries
for await (const msg of decodeMsgpack<{ type: string; text?: string }>(bytes)) {
  console.log(msg);
}
```

### Embeddings pipeline

```ts
import {
  decodeFloat32Arrays,
  encodeFloat32Arrays,
} from "@statewalker/webrun-msgpack";

async function* chunks() {
  yield new Float32Array([0.1, 0.2, 0.3, 0.4]);
  yield new Float32Array([0.5, 0.6, 0.7, 0.8]);
}

// wire-efficient: msgpack `bin` type reinterpreted byte-for-byte as Float32.
const pipe = decodeFloat32Arrays(encodeFloat32Arrays(chunks()));
for await (const arr of pipe) console.log(arr.length); // 4, 4
```

### Re-framing across transport chunks

```ts
import { decodeMsgpack, encodeMsgpack } from "@statewalker/webrun-msgpack";

// Produce one frame (a plain array is a valid input), then split the bytes any way you like:
const bytes: Uint8Array[] = [];
for await (const f of encodeMsgpack([{ a: 1, b: "hi" }])) bytes.push(f);
// Hand the decoder arbitrarily small slices — it buffers until complete:
async function* byOne() {
  for (const b of bytes) for (const byte of b) yield new Uint8Array([byte]);
}
for await (const v of decodeMsgpack<{ a: number; b: string }>(byOne())) {
  console.log(v); // { a: 1, b: "hi" }
}
```

### An RPC stream over a byte transport

`msgpackCodec` on both ends of a transport that carries `Uint8Array`s, one virtual port, one
`duplexOverPort` round trip. The pipe below stands in for the real thing — replace it with a
WebSocket pair, an `RTCDataChannel`, or a LiveKit packet stream and nothing else changes.

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

The same stack passes the unmodified `webrun-streams-conformance` L0–L6 suite over a byte pipe, in
both framing regimes — unlimited, and with frames capped at 64 KiB
(`tests/conformance-bytes.test.ts`).

**Read that green narrowly: an in-process pipe is not a transport.** The pipe hands `Uint8Array`s
straight from one object to another inside one process, so what the suite covers is this codec's own
contract end to end, including under chunking. It covers *none* of what a real byte transport brings:
framing, message-size ceilings and what a transport does when you exceed one, backpressure,
reconnection, close codes and error semantics. A WebSocket, an `RTCDataChannel` and a LiveKit data
track each need their own run before anything here is claimed of them.

## `maxMessageSize` bounds the payload, not the frame

**Leave a margin of at least 256 bytes below your transport's hard limit.** This is the one thing
that will bite you when wiring `msgpackCodec` to a capped transport, and the frame sizes below are
measured rather than cautious:

`duplexOverPort` applies `toChunks(maxMessageSize)` to the *payload*. The envelope framing —
`WireChunk`, `callPort`'s `{type, channelName, callId, params}`, the mux's `{type, id, payload}`,
then this codec — is added **on top, afterwards**. Over `msgpackCodec` that overhead is
`87 + len(callId)` bytes and it is **not constant**: `callId` is
`` `call-${Date.now()}-${String(Math.random()).substring(2)}` ``, whose length varies **31–40**
characters *per chunk* because `Math.random()` drops trailing zeros; the port id's integer width
adds 0–4; the channel name adds 1 for `"out"` over `"in"`; and a chunk at or above 64 KiB adds 2 as
the payload's `bin` header widens.

Two numbers, and the difference between them matters: adding those terms up gives a **modelled
ceiling of 134 bytes**, while the overheads *actually observed* span **123–128 bytes**. The 134 is
arithmetic; the 123–128 is measurement.

The largest, 128, comes from a **64 KiB** cap — a 65,664-byte frame in the capped conformance run
over a 10 MiB body — which is the regime where the `bin`-header term applies. A separate sweep, eight
runs at a **16 KiB** cap with a 1 MiB body (several thousand chunks, so several thousand `callId`s),
never exceeded **126** at that cap; the table below is one run per cap and is not that sweep. A
256-byte margin covers all of it, which is why the advice is a round number rather than a tight one.

Measured, with a 512 KiB body through the stack above:

| `maxMessageSize` | intent | largest frame actually posted | overhead |
| --- | --- | --- | --- |
| `16 * 1024` | an `RTCDataChannel`'s conservative ceiling | **16,508 bytes** | 124 |
| `12 * 1024` | LiveKit's safe packet size | **12,413 bytes** | 125 |
| `64 * 1024` | | **65,662 bytes** | 126 |

So setting `maxMessageSize` to the transport's hard limit **overruns it on the first full-size
chunk** — and a transport that silently drops an oversized message (LiveKit does; the body arrives
as zero bytes with no error on either side) gives you no signal at all. Set it to
`limit - 256` and the arithmetic stops mattering.

This is spec D10's correction, recorded in
`docs/superpowers/specs/2026-09-05-port-multiplexer-design.md`.

## Two things `msgpackCodec` does that `structuredCodec` does not

**The transfer list is ignored.** `PortCodec.post` receives an optional `Transferable[]`;
`msgpackCodec` drops it. After encoding, the payload is *inside* the bytes — there is no live
`ArrayBuffer` left on the far side of the call to hand over, and passing the caller's original
buffers as transferables would detach buffers the caller still owns. `structuredCodec` forwards the
list, because there the objects themselves cross.

**msgpack drops object keys whose value is explicitly `undefined`**; structured clone keeps them. So
`{ result: undefined }` arrives as `{}` over this codec and as `{ result: undefined }` over
`structuredCodec`. Nothing `webrun-rpc`'s layer 2 sends depends on the difference — every wire shape
it produces is pinned against both codecs in `tests/codec-equivalence.test.ts` — and per **spec
D16** it must not come to. If you build a payload where `"key" in obj` means something different
from `obj.key === undefined`, it will not survive this codec.

D16's reach has one open edge, worth knowing before you put arbitrary application errors on a byte
transport: `serializeError` copies **every own enumerable property** off a thrown `Error` onto the
wire. Whether the resulting `error` payload is msgpack-expressible therefore depends on what your
code throws — a `cause` holding a `Map` or a class instance collapses to `{}`, and a circular
reference makes `serialize` throw.

## What `deserialize` refuses, and how

`deserialize` throws on input that is not MessagePack; it never logs. Specifically:

- **Truncated input** — any read that would run past the end — throws a `RangeError`
  (`Insufficient data: …`). Every proper prefix of a valid encoding is refused this way, so a cut
  integer can no longer come back as `NaN`, nor a cut `bin` as a shorter array.
- **The never-used type byte `0xc1`**, an empty input, a timestamp extension of an unknown size,
  and a non-byte argument throw an `Error`.
- **Malformed UTF-8 inside a string is not an error**: each malformed sequence decodes to U+FFFD,
  exactly as `TextDecoder` does, and the values after the string are read normally. Overlong
  forms are malformed — `C0 AF` does not decode to `/`.
- **Bytes after the first document are ignored** unless `{ multiple: true }` asks for all of them.

`msgpackCodec` turns every one of these throws into a dropped message. (Before this package
carried its own implementation, `@ygoe/msgpack` printed the whole buffer with `console.debug` on
some truncated input before throwing. That is gone.)

## The value model

What each JavaScript value becomes on the wire, and what comes back:

| Written | As | Read back as |
| --- | --- | --- |
| `null`, `undefined` | nil | `null` — but an object key whose value is `undefined` is **dropped** |
| `boolean` | bool | `boolean` |
| safe integer | the narrowest int / uint | `number`; `-0` is written as `0` and loses its sign |
| any other number (fraction, beyond ±2⁵³, `NaN`, `±Infinity`) | float 64 | `number` |
| `string` | str, UTF-8; a lone surrogate is written as U+FFFD, as `TextEncoder` does | `string` |
| `Uint8Array`, `Uint8ClampedArray` | bin | `Uint8Array` — a **view into the input**, not a copy |
| other typed arrays (`Float32Array`, `Int16Array`, …) | array of numbers | `number[]` |
| `Array` | array | `unknown[]` |
| `Date` | timestamp extension (type -1), 32/64/96-bit as the instant needs | `Date`, floored to the millisecond; an invalid `Date` throws |
| any other object | map of its **own** enumerable string keys | plain object; every key, `__proto__` included, is an own property |
| `bigint`, `function`, `symbol` | — throws, unless `invalidTypeReplacement` supplies a stand-in | |

Reading also accepts what other encoders write: float 32, int 64 / uint 64 (as the nearest
`number` — precision beyond 2⁵³ is lost), maps with non-string keys (the key is converted with
`String()`), and extension types other than timestamps, which come back as
`{ type, data }` with `type` as the unsigned byte (so type `-2` reads as `254`). A `Map` or `Set`
has no own enumerable keys and is written as an empty map.

## Internals

### Frame layout

```
┌──────────────┬────────────────────────────┐
│  uint32 BE   │    msgpack payload         │
│  (4 bytes)   │    (`length` bytes)        │
└──────────────┴────────────────────────────┘
```

- Big-endian 32-bit length prefix — same convention as Java `DataOutputStream` and most wire protocols.
- Max payload per frame: 2³²−1 bytes. No fragmentation within a frame (a single call to `serialize` produces the whole payload up-front); very large values will allocate proportionally.
- **This layout is the stream codec's only.** `msgpackCodec` writes a bare msgpack document per
  message and prefixes nothing.

### Decoder state machine

The decoder keeps a rolling `Uint8Array` buffer. Each incoming chunk is appended (single allocation per chunk); then:

1. If buffer is shorter than 4 bytes — wait for more.
2. Read the 32-bit BE length.
3. If buffer doesn't hold `4 + length` bytes — wait for more.
4. Copy the payload out, `deserialize` it, yield.
5. Advance the buffer past this frame; repeat step 1.

Zero-length chunks are tolerated and simply no-op through the loop. Truncated trailing frames are silently dropped — the buffer retains them but the consuming `for await` ends without yielding a partial value.

### What `msgpackCodec.read` accepts, and what it refuses

It accepts whatever byte shape a transport pump hands over — a `Uint8Array`, a bare `ArrayBuffer`,
or any `ArrayBufferView` (a `DataView` included, offset and length honoured). Everything else is
refused by returning `undefined`: a non-byte value, empty bytes, malformed msgpack, and well-formed
msgpack that decodes to something that is not a `PortEnvelope` (the `id` must be a non-negative
integer and the `type` one of `open` / `message` / `close`). A shared transport carries traffic that
is not ours, and layer 1 must not mistake it for an envelope.

Refusal is always a dropped message, never a throw: a throw here would escape inside the raw port's
own listener, outside any consumer's reach, and would let one hostile frame take the multiplexer
down.

There are three inputs for which `read` *can* still throw, all inside the byte-shape check that runs
before the `try`: a detached `ArrayBuffer`, a `DataView` over a detached buffer, and a `Proxy` with
a throwing `getPrototypeOf`. None is producible by a remote peer sending bytes — each needs
same-process JavaScript already holding the backing memory — so the guarantee is "cannot throw for
anything that arrives over a wire", not "cannot throw for any JavaScript value".

### Float32Array: no per-element conversion

`encodeFloat32Arrays` constructs a `Uint8Array` view over the `Float32Array`'s underlying buffer and serialises it as a msgpack `bin` payload — no float-by-float conversion. `decodeFloat32Arrays` reinterprets the decoded `Uint8Array` as a `Float32Array`, copying it first when its `byteOffset` is not 4-byte aligned.

**In practice that copy always happens**, and the bytes are copied on the way out as well:
`serialize` copies the view into its output, and the frame is assembled by another copy. The
decoded `bin` is a view into the payload, starting just after its 2-, 3- or 5-byte header, and
none of those offsets is a multiple of 4. So "no per-element conversion" is the whole claim, not
"zero-copy".

### A trap when writing a transport pump

`serialize` returns a **view** over an internal buffer that is not trimmed: a 10 MiB envelope
measures ~10,485,800 bytes over a 16,777,216-byte `ArrayBuffer` (~1.6× slack, `byteOffset` 0). Send
the view. A pump that reaches for `frame.buffer` instead would put ~6 MiB of trailing zeros on the
wire per message.

### Dependencies

- [`@statewalker/webrun-rpc`](../webrun-rpc) — **types only** (`PortCodec`, `PortEnvelope`); no runtime import is emitted.
- MessagePack itself is `src/msgpack-core.ts`, in this package — see below.

Dev: TypeScript, vitest, rolldown, rimraf (catalog versions from the monorepo root).
`@statewalker/webrun-streams` and `@statewalker/webrun-streams-conformance` are dev-only, for the
conformance run.

### Constraints

- Big-endian length prefix only — no little-endian variant.
- `decodeMsgpack` allocates one `Uint8Array` per incoming chunk for the `concat`; long streams with many tiny chunks may benefit from a batched source upstream.
- `Float32Array` codec is strictly `Float32` — no element-size negotiation.
- `msgpackCodec` carries no length prefix, so it is **unusable** on a transport without message
  boundaries. Use the stream codec there.

## Scripts

```sh
pnpm test              # vitest run (406 tests / 7 files)
pnpm run build         # rolldown + tsc --emitDeclarationOnly
pnpm lint              # biome check src tests
pnpm typecheck         # tsc --noEmit (src)
pnpm typecheck:tests   # tsc -p tsconfig.tests.json — needs the sibling packages built
```

## Provenance and credits

`src/msgpack-core.ts` is a TypeScript port of **[msgpack.js](https://github.com/ygoe/msgpack.js)**
by **Yves Goergen**, © 2019, MIT license — the library this package depended on, as
[`@ygoe/msgpack`](https://www.npmjs.com/package/@ygoe/msgpack), until 0.3.0. Thank you.

It is ported from commit
[`05733cf`](https://github.com/ygoe/msgpack.js/tree/05733cfb43a2974cf669f0eb8693f43b548bdcd4)
(2024-04-16) on `master`, not from the npm release 1.0.3. `master` carries three fixes that 1.0.3
lacks, and they change what goes on the wire:

- [#34](https://github.com/ygoe/msgpack.js/pull/34): an integer beyond the safe range is written
  as a float 64. 1.0.3 wrote `2 ** 100` as the maximal uint 64, which reads back as ~1.8e19.
- [#32](https://github.com/ygoe/msgpack.js/issues/32): a positive integer above uint 32 is written
  with the uint 64 prefix `0xcf`, not int 64's `0xd3`.
- [#33](https://github.com/ygoe/msgpack.js/issues/33): a 16–255-byte `bin` gets the one-byte bin 8
  header, not bin 16's two bytes.

The port keeps upstream's structure, comments and error messages. Before any change it was checked
against upstream `msgpack.js` itself: byte-identical output for 3,000 randomised values (226 MB
encoded), and the same value or the same error message for 20,000 random garbage inputs.

**Changes from upstream**, each marked `Modified from upstream` in the source and made where a
test adopted from another implementation failed:

1. **Truncated input throws a `RangeError`** instead of decoding to `NaN` or a short `bin`, and
   nothing is logged — upstream called `console.debug` with the whole input.
2. **Timestamps are floored to the millisecond**, both ways. Upstream rounded
   `…:07.999999999Z` up to the next second, read pre-1970 instants toward zero, and wrote
   `new Date(-1002)` as second -1. An invalid `Date` throws instead of being written as second -1.
3. **Strings follow the WHATWG Encoding standard.** Decoding goes through `TextDecoder`: malformed
   sequences, overlong forms included, become U+FFFD, where upstream decoded `C0 AF` to `/` and
   threw on a sequence cut by the end of the string. Encoding writes a lone surrogate as U+FFFD,
   where upstream threw on a high one and wrote a low one as invalid UTF-8.
4. **Object keys**: a `__proto__` map key is decoded as an own property — upstream's assignment
   replaced the decoded object's prototype — and only own enumerable keys are written, where
   upstream's `for…in` also wrote inherited ones.
5. TypeScript types, `unknown` in place of `any`, and the bounds `0xffffffffffffffff` /
   `0x7fffffffffffffff` spelled `2 ** 64` / `2 ** 63` (the same doubles).

**Tests.** Besides this package's own, the suite runs:

- upstream's test page, ported to vitest — `tests/msgpack-core.upstream.test.ts`;
- [kawanet/msgpack-test-suite](https://github.com/kawanet/msgpack-test-suite) (MIT, © Yusuke
  Kawasaki), vendored — `tests/msgpack-core.test-suite.test.ts`;
- cases adopted from [msgpack/msgpack-javascript](https://github.com/msgpack/msgpack-javascript)
  (ISC, © The MessagePack Community) and [kriszyp/msgpackr](https://github.com/kriszyp/msgpackr)
  (MIT, © Kris Zyp), with msgpackr's sample documents vendored —
  `tests/msgpack-core.adopted.test.ts`.

Sources, commits and licenses of everything vendored are in
[`tests/fixtures/README.md`](./tests/fixtures/README.md). Outside the suite, the final
implementation was checked for interoperability with `@msgpack/msgpack` 3.1.3 and `msgpackr` 2.1.0:
2,000 random values encoded by each side decode identically on the other, in both directions.

## License

MIT © statewalker — see [LICENSE](./LICENSE), which also carries msgpack.js's MIT notice.
