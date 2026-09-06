# @statewalker/webrun-msgpack

MessagePack on the wire, in **two distinct shapes**:

- a **stream codec** — `encodeMsgpack` / `decodeMsgpack`, length-prefixed, for a transport with no
  message boundaries (plus zero-copy specialisations for `Float32Array`);
- a **message codec** — `msgpackCodec`, a `PortCodec` for `@statewalker/webrun-rpc`'s
  `multiplexPort`, with no length prefix, for a transport that already frames.

They are not interchangeable, and reaching for the wrong one is easy. The table below is the whole
decision.

## Which codec

| | `encodeMsgpack` / `decodeMsgpack` | `msgpackCodec` |
| --- | --- | --- |
| Kind | stream codec | message codec (`PortCodec`) |
| Shape | `AsyncIterable<T>` ⇄ `AsyncIterable<Uint8Array>` | one `PortEnvelope` ⇄ one `postMessage` |
| Framing | **4-byte big-endian length prefix**, added by this package | **none** — the transport's own message boundaries are the framing |
| Use it when | the transport is a byte *stream*: a TCP-like socket, a `ReadableStream`, a file, anything where chunk boundaries are arbitrary | the transport preserves *message* boundaries: a WebSocket, an `RTCDataChannel`, a LiveKit data packet |
| Malformed input | a truncated trailing frame is never emitted; the consumer ends without yielding a partial value | dropped, never thrown — a bad frame from a peer cannot take the multiplexer down |
| Depends on | `@ygoe/msgpack` only | `@ygoe/msgpack`, plus **type-only** `@statewalker/webrun-rpc` |

Adding a length prefix on a transport that already frames is redundant framing; relying on message
boundaries where there are none is the truncation bug the stream codec exists to prevent. Pick by
the transport, not by taste.

## Why the stream codec exists

Consumers that pipe values across transports (scanners writing chunks to a store, chat pipelines streaming embeddings, etc.) need a way to serialise a stream of objects into a byte stream and reassemble it on the other side without truncation surprises.

A raw MessagePack stream has no frame boundaries: a decoder can only succeed if the chunk boundaries happen to line up with the payload boundaries. Length-prefix framing fixes this — the decoder buffers incoming bytes and only yields when a complete `[length][payload]` pair is available. Partial trailing frames are NEVER emitted, so callers can detect truncation by comparing observed count to expected.

Previously the codec lived inside `@repo/streams` (private, unpublished). It's been extracted here so (a) consumers that only need framing don't pull in the broader `webrun-streams` surface, and (b) the `@ygoe/msgpack` dependency lives in exactly one place.

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

One runtime dependency **in the emitted bundle**
([`@ygoe/msgpack`](https://www.npmjs.com/package/@ygoe/msgpack)), no peer dependencies. ESM only
(`"type": "module"`). That is not the same as the install cost: `@statewalker/webrun-rpc` is a
declared `dependency`, so `npm install` also pulls it and, transitively, `@statewalker/webrun-streams`
into `node_modules` — even for a consumer who uses only the stream codec.

`@statewalker/webrun-rpc` is declared as a dependency but is **type-only**: `msgpackCodec` imports
the `PortCodec` interface from it and no runtime code, so nothing of `webrun-rpc` is in the built
bundle (`dist/index.js` imports `@ygoe/msgpack` and nothing else) and `webrun-rpc` gains no msgpack
dependency in either direction.

## How to use

### Exports

| Export | Direction | Use case |
| --- | --- | --- |
| `encodeMsgpack<T>(src: AsyncIterable<T>)` | values → bytes | generic JSON-ish values |
| `decodeMsgpack<T>(src: AsyncIterable<Uint8Array>)` | bytes → values | inverse of `encodeMsgpack` |
| `encodeFloat32Arrays(src: AsyncIterable<Float32Array>)` | arrays → bytes | zero-copy float streaming |
| `decodeFloat32Arrays(src: AsyncIterable<Uint8Array>)` | bytes → arrays | inverse of `encodeFloat32Arrays` |
| `msgpackCodec: PortCodec` | envelope ⇄ one framed message | `multiplexPort` over a byte transport |

## Examples

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

// Produce one frame, then split the bytes any way you like:
const bytes = [];
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

## A `@ygoe/msgpack` wart, so nobody debugs it twice

On some truncated input `@ygoe/msgpack`'s `deserialize` calls **`console.debug("msgpack array:", …)`
with the whole offending buffer** before it throws. `msgpackCodec` catches the throw and drops the
frame, but it cannot suppress the log — the call is inside the library.

Precisely: the log fires when the decode runs off the end of the buffer *where a byte code is
expected* (`Invalid byte value 'undefined' at index N`). A truncation that lands mid-string throws
`Cannot read properties of undefined (reading 'toString')` with no log, and `0xc1` garbage or empty
input throws silently. So the noise is real but intermittent — a peer that half-writes a frame will
print a buffer dump on your console and nothing will be wrong with your code.

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
4. Slice the payload, deserialise with `@ygoe/msgpack`, yield.
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

### Float32Array zero-copy

`encodeFloat32Arrays` constructs a `Uint8Array` view over the `Float32Array`'s underlying buffer and serialises it as a msgpack `bin` payload — no float-by-float conversion. `decodeFloat32Arrays` reinterprets the decoded `Uint8Array` as a `Float32Array`. When the decoded buffer's `byteOffset` is not 4-byte aligned (can happen if `@ygoe/msgpack` returns a view into a larger buffer), we copy into a fresh aligned `Uint8Array` before constructing the `Float32Array`; otherwise the operation is view-only.

### A trap when writing a transport pump

`serialize` returns a **view** over an internal buffer that is not trimmed: a 10 MiB envelope
measures ~10,485,800 bytes over a 16,777,216-byte `ArrayBuffer` (~1.6× slack, `byteOffset` 0). Send
the view. A pump that reaches for `frame.buffer` instead would put ~6 MiB of trailing zeros on the
wire per message.

### Dependencies

- [`@ygoe/msgpack`](https://github.com/ygoe/msgpack.js) — single-file msgpack implementation (≈7 kB gzipped), no transitive deps.
- [`@statewalker/webrun-rpc`](../webrun-rpc) — **types only** (`PortCodec`, `PortEnvelope`); no runtime import is emitted.

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
pnpm test              # vitest run (84 tests / 4 files)
pnpm run build         # rolldown + tsc --emitDeclarationOnly
pnpm lint              # biome check src tests
pnpm typecheck         # tsc --noEmit (src)
pnpm typecheck:tests   # tsc -p tsconfig.tests.json — needs the sibling packages built
```

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
