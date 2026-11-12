# @statewalker/webrun-streams

## What it is

Async-iterator and `ReadableStream` primitives, plus the transport seam the
`webrun-streams-*` adapters are written against. It contains collectors
(`collect`, `collectBytes`, `collectString`), text, line and JSONL codecs, a
backpressure-aware callback-to-generator bridge, a chunk protocol for moving an
iterator across any message channel, conversions between async iterators and
WHATWG `ReadableStream<Uint8Array>`, serialisable errors, and the `Duplex` /
`Connect` / `Serve` types with `TransportClosedError`. It implements no
transport and no multiplexer: those live in the adapters and in
`@statewalker/webrun-rpc`.

## Why it exists

Code that moves bytes between a browser, a worker, a server and a peer needs
the same small set of building blocks in every place:

1. **Collectors** that turn an async iterable into an array, a `Uint8Array` or a
   `string` without boilerplate.
2. A **callback-to-async-iterator bridge** with backpressure, so a producer
   knows when the consumer has taken a value or stopped listening.
3. A **chunk protocol**: a `{ done, value?, error? }` envelope that crosses any
   transport (MessagePort, WebSocket, IPC, in-memory) and rebuilds the iterator
   on the other side, errors included.
4. **WHATWG to async-iterator conversions** that carry cancellation, so code
   written against `fetch` bodies interoperates with `for await` code.
5. **Error serialisation** that keeps `message`, `stack` and custom fields across
   JSON and structured-clone boundaries.
6. **Line, JSONL and text codecs**, so stream code does not re-implement
   split/join/encode/decode.
7. **One seam for transports.** Every adapter exposes the same `Duplex` shape,
   so code above the transport does not change when the transport does.
   Message-oriented transports have no streams of their own; they get them
   from `@statewalker/webrun-rpc`'s port stack (`overPipe` with
   `msgpackCodec` from `@statewalker/webrun-msgpack`, then `webrun-rpc`'s
   `connect` / `serve`), which resolves to these same types. This package
   holds only the types, so the seam does not depend on any one
   implementation of it.

## How to use

```sh
pnpm add @statewalker/webrun-streams
```

No runtime dependencies and no peer dependencies. ESM only. One entry point,
`.` (the package root), which exports everything listed below. It uses only
platform globals (`TextEncoder`, `TextDecoder`, `ReadableStream`, `Blob`), so it
runs in browsers, workers and Node.

| Export | What it does |
| --- | --- |
| `collect(it)` | Drain an `AsyncIterable<T>` into `T[]`. |
| `collectBytes(it)` | Concatenate `AsyncIterable<Uint8Array>` into one `Uint8Array`. A single chunk is returned as is, without a copy. |
| `collectString(it)` | Concatenate `AsyncIterable<string>` into one `string`. |
| `encodeText(it)` / `decodeText(it)` | UTF-8 `AsyncIterable<string>` to `AsyncGenerator<Uint8Array>` and back. `decodeText` handles multi-byte characters split across chunks. |
| `splitLines(it)` / `joinLines(it)` | Split string chunks on `\n` (lines may span chunks); append `\n` to each string. |
| `encodeJsonl(it)` / `decodeJsonl(it)` | Values to `\n`-terminated JSON strings; string chunks to parsed values. `decodeJsonl` splits lines itself and skips blank lines. |
| `map(it, fn)` | Map an `AsyncIterable<I>` through `fn: (item) => O \| Promise<O>`. |
| `newAsyncGenerator(init, skipValues?)` | Bridge `next(value)` / `done(error?)` callbacks into an `AsyncGenerator<T>`. Both callbacks return `Promise<boolean>`. |
| `sendIterator(send, iterable)` | Drain an iterable into `send({ done, value, error })` calls, ending with exactly one `{ done: true }` chunk. |
| `recieveIterator(installer)` | Inverse of `sendIterator`: turn delivered chunks into an `AsyncGenerator<T>`. |
| `toReadableStream(iterator)` | Wrap an `AsyncIterator<Uint8Array>` in a `ReadableStream<Uint8Array>`. |
| `fromReadableStream(stream)` | Iterate a `ReadableStream<Uint8Array>` as an `AsyncGenerator<Uint8Array>`. |
| `normalizeToUint8Array(value)` | Coerce a `ByteLike` (`Uint8Array`, `ArrayBuffer`, `ArrayBufferView`, `Blob`, `string`) to `Uint8Array`. Synchronous, except a `Blob`, which returns a `Promise<Uint8Array>`. |
| `toChunks(size?)` | Curried. Returns a transform that splits `Uint8Array` chunks into pieces of at most `size` bytes (default 16384). |
| `serializeError(error)` / `deserializeError(obj \| string)` | `Error` (or anything) to a plain `SerializedError` and back, keeping own enumerable fields. |
| `newCreditLedger(initial?)` / `newCreditGrantor(window, threshold?)` | **Dormant.** The sender and receiver halves of credit-based flow control, as pure state machines. Nothing in this repository uses them since `emulateMux` was removed (Plan C3); they stay exported and tested for per-stream windowing (spec D13). |
| `TransportClosedError` | Error class raised when a transport closes with calls in flight. |

Types: `Duplex`, `Connect<P>`, `Serve<P>`, `ByteLike`, `CreditLedger`,
`CreditGrantor`, `IteratorChunk<T>`,
`ChunkSender<T>`, `ChunkReceiver<T>`, `ReceiverInstaller<T>`,
`SerializedError`.

### The `Duplex` seam

```ts
type Duplex = (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => AsyncGenerator<Uint8Array>;
type Connect<P> = (params: P) => Promise<{ call: Duplex; close: () => Promise<void> }>;
type Serve<P> = (params: P, handler: Duplex) => Promise<() => Promise<void>>;
```

One `Duplex` invocation carries one logical call: the caller supplies input
bytes, the peer yields output bytes. Caller and handler have the same shape, so
an in-process test can set `const call = handler` and run with no transport.
`Connect` stands up one transport and returns a `call`; each `call` opens a new
sub-stream on it. `Serve` registers a handler and resolves to an idempotent
teardown.

Iterator semantics carry every signal, so there is no separate close or abort
API:

| Signal | Mechanism |
| --- | --- |
| Consumer is done early | `.return()` on the output; the producer's `finally` runs |
| Producer failed | `throw`; the consumer's `for await` throws |
| Either side finished normally | Normal exhaustion; matching end on the other side |

**Caller obligation.** Either drain the returned generator or `.return()` it.
Dropping the reference does neither: the consumer never acknowledges inbound
data, the peer's outbound pump blocks waiting for that acknowledgement, no end-of-stream is
exchanged, and both peers hold the stream open. An unreferenced generator is
not observable, so no transport can detect this for you.

## Examples

### Collectors

```ts
import { collect, collectBytes, collectString } from "@statewalker/webrun-streams";

async function* numbers() { yield 1; yield 2; yield 3; }
await collect(numbers());              // [1, 2, 3]

async function* bytes() {
  yield new Uint8Array([1, 2]);
  yield new Uint8Array([3]);
}
await collectBytes(bytes());           // Uint8Array(3) [1, 2, 3]

async function* strings() { yield "a"; yield "bc"; }
await collectString(strings());        // "abc"
```

### Text, JSONL and line codecs

```ts
import {
  collectString,
  decodeJsonl,
  decodeText,
  encodeJsonl,
  encodeText,
  splitLines,
} from "@statewalker/webrun-streams";

async function* chunks() {
  yield new Uint8Array([0x7b, 0x22, 0x61]);              // '{"a'
  yield new Uint8Array([0x22, 0x3a, 0x31, 0x7d, 0x0a]);  // '":1}\n'
}

// `decodeJsonl` splits lines itself. Do not wrap its input in `splitLines`:
// the lines lose their "\n", arrive concatenated, and `JSON.parse` throws.
for await (const v of decodeJsonl<{ a: number }>(decodeText(chunks()))) {
  console.log(v); // { a: 1 }
}

// The inverse. `encodeJsonl` already ends each value with "\n", so adding
// `joinLines` would emit a blank line after every record.
async function* records() { yield { a: 1 }; yield { a: 2 }; }
await collectString(decodeText(encodeText(encodeJsonl(records())))); // '{"a":1}\n{"a":2}\n'

// `splitLines` / `joinLines` are for plain string streams.
async function* text() { yield "one\ntw"; yield "o\n"; }
for await (const line of splitLines(text())) console.log(line); // "one", "two"
```

### Callback to AsyncGenerator bridge

```ts
import { newAsyncGenerator } from "@statewalker/webrun-streams";

function tickEverySecond(): AsyncGenerator<number> {
  return newAsyncGenerator<number>((next, done) => {
    let n = 0;
    const id = setInterval(() => {
      if (n < 5) void next(n++);
      else {
        void done();
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id); // runs if the consumer stops early
  });
}

for await (const n of tickEverySecond()) console.log(n); // 0 … 4
```

### Iterator chunk protocol

```ts
import {
  type ChunkReceiver,
  type IteratorChunk,
  collect,
  recieveIterator,
  sendIterator,
} from "@statewalker/webrun-streams";

// Stand-in for a real channel: whatever is sent is delivered to the receiver.
let deliver: ChunkReceiver<number> | undefined;
const transport = async (chunk: IteratorChunk<number>) => {
  await deliver?.(chunk);
};

const iter = recieveIterator<number>((d) => {
  deliver = d;
});

// Consume while sending. `deliver` resolves only once the consumer has taken
// the chunk (that is the backpressure), so awaiting `sendIterator` with nobody
// iterating `iter` deadlocks.
const [, received] = await Promise.all([sendIterator(transport, [1, 2, 3]), collect(iter)]);
console.log(received); // [1, 2, 3]
```

### WHATWG streams and async iterators

```ts
import { fromReadableStream, toReadableStream } from "@statewalker/webrun-streams";

async function* encoded() {
  const e = new TextEncoder();
  yield e.encode("hello ");
  yield e.encode("world");
}

const response = new Response(toReadableStream(encoded()));
for await (const chunk of fromReadableStream(response.body!)) {
  // chunk: Uint8Array
}
```

### Byte normalisation and re-chunking

```ts
import { collect, normalizeToUint8Array, toChunks } from "@statewalker/webrun-streams";

normalizeToUint8Array("ab");                      // Uint8Array [97, 98]
await normalizeToUint8Array(new Blob(["ab"]));    // Blob input returns a Promise

async function* big() { yield new Uint8Array(20_000); }
(await collect(toChunks()(big()))).map((c) => c.byteLength); // [16384, 3616]
```

### Error round trip

```ts
import { deserializeError, serializeError } from "@statewalker/webrun-streams";

class NotFoundError extends Error {
  status = 404;
}

const wire = serializeError(new NotFoundError("missing"));
//    { message: "missing", stack: "…", status: 404 }

const restored = deserializeError(wire) as Error & { status?: number };
restored instanceof Error; // true (a plain Error, not NotFoundError)
restored.status;           // 404
```

## Internals

### The credit pair is dormant

`newCreditLedger` and `newCreditGrantor` are credit-based flow control with no
I/O: the receiver states what it can buffer, and the sender may put on the wire
only what it has been granted. Their consumer, `emulateMux` (a byte-channel
multiplexer that lived in this package), was removed in Plan C3; the port stack
in `@statewalker/webrun-rpc` that replaced it keeps its own window. They stay
exported and tested as the mechanism for per-stream windowing (spec D13) rather
than be rewritten later.

Their behaviour, for when they are used: `reserve(upTo)` on the ledger resolves
with whatever is available, at least 1 and at most `upTo`, and waiters are
released strictly in order, so a peer whose window is smaller than one request
still makes progress, one short piece at a time. The grantor hands credit back
only for units the consumer actually took, batched until `threshold` (default
`0.5`) of the window has drained, and flushed as soon as the receive queue is
empty, so the receiver never sits on credit it owes. The unit is opaque: count
bytes or values.

### `newAsyncGenerator` is a backpressure queue

A singly linked queue of slots, each holding a value or a terminal
`{ done: true, error? }`. `next(value)` and `done(error?)` return a
`Promise<boolean>` that resolves `true` once the consumer has dequeued the slot,
so a producer applies backpressure by awaiting. When the consumer exits early,
the cleanup function returned by `init` runs and every pending slot resolves
`false`, telling the producer its value was not consumed.

`skipValues: true` keeps only the newest value: pushing a value drops any
unconsumed older ones, whose promises resolve `false`. Use it where only the
latest state matters (live previews, resize events). A producer cannot tell
"skipped" from "consumer left"; both mean "not consumed".

### Chunk protocol

```
{ done: false, value: T }   a value
{ done: true,  error?: E }  termination; an error is rethrown by the receiver
```

`sendIterator` always sends exactly one `done` chunk. An error thrown by the
source iterable is caught and travels in that chunk's `error` field;
`recieveIterator` rethrows it into the consumer's `for await`. An error thrown
by `send` itself propagates out of `sendIterator`. `recieveIterator` treats a
falsy `error` as no error, so a source that throws `0`, `""` or `null` ends the
stream normally on the receiving side.

The exported name `recieveIterator` is spelled that way, and dependents import
it under that name.

### Why the `ReadableStream` adapters carry cancellation

A response body can leave a handler as a `ReadableStream`, cross a transport
as an iterator, and become a `ReadableStream` again at the caller. When the
caller walks away, the only way back to the producer runs through these two
functions. So:

- `toReadableStream` pulls one chunk per `pull`, which keeps the stream's own
  backpressure and leaves a point between chunks where cancellation can act.
  `cancel(reason)` calls the iterator's `return(reason)` without awaiting it,
  for the queued-behind-`next()` reason above. It uses a default (non-byte)
  stream.
- `fromReadableStream` cancels the source when the consumer stops early
  (`break`, `.return()`, an error) and only releases the lock when the stream
  ended on its own.

Both assume `Uint8Array` chunks.

### Other edge cases

- `serializeError` copies own enumerable properties; `deserializeError` returns
  a plain `Error` with those fields assigned, not an instance of the original
  subclass. `name` is restored only if it was an own property.
- `toChunks(size)` throws `RangeError: toChunks: size must be a positive integer, got <size>`.
  Empty input chunks are skipped; oversized ones are split with zero-copy
  `subarray` views.
- `normalizeToUint8Array` throws `TypeError: normalizeToUint8Array: unsupported input <type>; expected Uint8Array, ArrayBuffer, ArrayBufferView, Blob, or string`.
- `newCreditLedger().reserve(upTo)` rejects with
  `RangeError: newCreditLedger: reserve(<upTo>) — upTo must be at least 1`;
  after `fail(err)`, every pending and future `reserve` rejects with `err`.

### Who implements the seam

`@statewalker/webrun-rpc`'s `connect` / `serve` implement `Connect` / `Serve`
over ports. Message-oriented transports supply only a pipe of bytes for its
port stack: `@statewalker/webrun-streams-ws`, `@statewalker/webrun-streams-peerjs`,
`@statewalker/webrun-streams-livekit` and `@statewalker/webrun-streams-signaling`.
Transports with native multiplexing (`@statewalker/webrun-streams-webrtc`,
`@statewalker/webrun-streams-libp2p`) implement the seam directly, one call per
native stream. Nothing in this package names a concrete transport.

### Dependencies

Zero runtime dependencies and zero peer dependencies. Only platform globals are
used.

## License

MIT
