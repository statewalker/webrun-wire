# @statewalker/webrun-streams

Async-iterator and `ReadableStream` primitives: `collect` / `collectBytes` / `collectString`, text and JSONL codecs, line splitting/joining, a backpressure-aware queue-based generator, a chunk protocol for pushing iterators across transports, conversions between async iterators and WHATWG `ReadableStream<Uint8Array>`, and serialisable `Error` objects.

It also defines the **`Duplex` seam** the whole `webrun-streams-*` transport family implements, and `emulateMux` — a stream multiplexer that turns any message-oriented byte channel into many concurrent `Duplex` calls.

## Why it exists

Every higher-level package in the `webrun-*` family (and its consumers — scanners, indexers, chat pipelines) needs the same small set of building blocks:

1. **Collectors** — turn any async iterable into a concrete array / `Uint8Array` / `string` without boilerplate; zero-copy short-circuit when a single chunk is produced.
2. A **callback-to-async-iterator** bridge — turn incoming `{done, value, error}` callbacks into a `for await` loop, with backpressure so producers know when consumers have stopped listening.
3. A **chunk protocol** — a tiny `{done, value?, error?}` envelope that can travel across any transport (MessagePort, WebSocket, IPC, in-memory) and rebuild the original iterator on the other side.
4. **WHATWG ↔ async-iterator** conversions for body bytes, so code written against `fetch` (`ReadableStream<Uint8Array>`) can interoperate with `for await` code and back.
5. **Error (de)serialisation** for passing exceptions across structured-clone / JSON boundaries without losing stacks or extra fields.
6. **Line / JSONL / text codecs** so stream-processing code doesn't re-invent split/join/encode/decode in every consumer.

The MessagePack codec that previously rode along here is split out to [`@statewalker/webrun-msgpack`](../webrun-msgpack) so consumers that don't need framing don't pull in `@ygoe/msgpack`.

## Install

```sh
npm install @statewalker/webrun-streams
```

Zero runtime dependencies, zero peer dependencies. ESM only
(`"type": "module"`); runs in browsers, Node, Deno, Bun and Workers. This is the
foundation package — everything else in the workspace depends on it.

## How to use

```sh
npm install @statewalker/webrun-streams
```

| Export | Purpose |
| --- | --- |
| `collect(it)` | Drain `AsyncIterable<T>` into `T[]`. |
| `collectBytes(it)` | Concatenate `AsyncIterable<Uint8Array>` into one `Uint8Array` (zero-copy when a single chunk). |
| `collectString(it)` | Concatenate `AsyncIterable<string>` into one `string`. |
| `encodeText(it)` / `decodeText(it)` | UTF-8 `AsyncIterable<string>` ↔ `AsyncIterable<Uint8Array>`. |
| `splitLines(it)` / `joinLines(it)` | Line splitting over `string` streams (handles cross-chunk lines) and reverse. |
| `encodeJsonl(it)` / `decodeJsonl(it)` | JSON values ↔ `\n`-delimited JSON string stream. |
| `map(it, fn)` | Stream-map an `AsyncIterable<T>` through `fn: T => U \| Promise<U>`. |
| `newAsyncGenerator(init, skipValues?)` | Bridge imperative `next/done` callbacks into an `AsyncGenerator<T>`; returns `Promise<boolean>` for backpressure. |
| `sendIterator(send, iterable)` | Drain an (async) iterable into `send({done, value, error})` chunk calls; completes with one trailing `{done: true}` chunk. |
| `recieveIterator(installer)` | Inverse of `sendIterator`: wire an installer's chunk callback into a new `AsyncGenerator<T>`. |
| `toReadableStream(it)` | Wrap an `AsyncIterator<Uint8Array>` in a `ReadableStream<Uint8Array>`. |
| `fromReadableStream(stream)` | Iterate a `ReadableStream<Uint8Array>` as `AsyncGenerator<Uint8Array>`. |
| `emulateMux(channel, opts?)` | Multiplex many concurrent `Duplex` calls over one `ByteChannel`; returns `{ call, serve, close }`. |
| `normalizeToUint8Array(value)` | Coerce a `ByteLike` (string, `ArrayBuffer`, typed array, `Blob`) to `Uint8Array`. Synchronous except for a `Blob`, which returns a `Promise`. |
| `toChunks(size?)` | Curried: returns a transform that re-chunks an `AsyncIterable<Uint8Array>` into pieces of at most `size` bytes. `size` defaults to 16384. |
| `serializeError(error)` | Turn an `Error` (or anything) into a plain `{message, stack, …}` object preserving subclass fields. |
| `deserializeError(obj \| string)` | Reconstruct an `Error` from a serialised form, restoring extra fields. |

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

### Text / JSONL / lines codecs

```ts
import {
  decodeJsonl,
  decodeText,
  encodeJsonl,
  encodeText,
  joinLines,
  splitLines,
} from "@statewalker/webrun-streams";

async function* chunks() {
  yield new Uint8Array([0x7b, 0x22, 0x61]);  // partial
  yield new Uint8Array([0x22, 0x3a, 0x31, 0x7d, 0x0a]);
}

// `decodeJsonl` splits lines itself — do not wrap it in `splitLines`, or a
// stream carrying more than one value arrives as one concatenated line and
// `JSON.parse` throws.
const values = decodeJsonl<{ a: number }>(decodeText(chunks()));
for await (const v of values) console.log(v); // { a: 1 }

// inverse. `encodeJsonl` already terminates each value with "\n", so
// `joinLines` here would emit a blank line between every record.
const jsonl = encodeText(encodeJsonl([{ a: 1 }, { a: 2 }]));

// `splitLines` / `joinLines` are for plain string streams, with no JSON involved:
for await (const line of splitLines(decodeText(byteStream))) console.log(line);
```

### Callback → AsyncGenerator bridge

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
    return () => clearInterval(id); // cleanup if consumer breaks early
  });
}

for await (const n of tickEverySecond()) console.log(n); // 0 … 4
```

### Iterator chunk protocol

```ts
import { collect, recieveIterator, sendIterator } from "@statewalker/webrun-streams";

// Drain an iterable across any transport.
async function transport<T>(chunk: { done: boolean; value?: T; error?: unknown }) {
  await myChannel.send(chunk); // …however your channel sends
}

// On the other side, rebuild the original iterator.
const iter = recieveIterator<number>((deliver) => {
  myChannel.onMessage = (chunk) => deliver(chunk);
});

// Start consuming *before* (or concurrently with) draining the source.
// `deliver` resolves only once the consumer has dequeued the chunk — that is
// the backpressure — so awaiting `sendIterator` with nobody iterating `iter`
// deadlocks both sides.
const [, received] = await Promise.all([
  sendIterator(transport, [1, 2, 3]),
  collect(iter),
]);
console.log(received); // [1, 2, 3]
```

### WHATWG streams ↔ async iterators

```ts
import { fromReadableStream, toReadableStream } from "@statewalker/webrun-streams";

async function* encoded() {
  const e = new TextEncoder();
  yield e.encode("hello ");
  yield e.encode("world");
}

// Give an iterable a ReadableStream face for fetch / Response.
const response = new Response(toReadableStream(encoded()));

// …and the other way around.
const reqBody = new Request("/x", { method: "POST", body: response.body }).body!;
for await (const chunk of fromReadableStream(reqBody)) {
  // chunk: Uint8Array
}
```

### Error roundtrip

```ts
import { serializeError, deserializeError } from "@statewalker/webrun-streams";

class NotFoundError extends Error {
  status = 404;
}

const wire = serializeError(new NotFoundError("missing"));
//    { message: "missing", stack: "…", status: 404 }

const restored = deserializeError(wire) as Error & { status?: number };
console.log(restored instanceof Error); // true
console.log(restored.status);           // 404
```

## The `Duplex` seam

Everything in the `webrun-streams-*` family speaks one shape:

```ts
type Duplex = (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => AsyncGenerator<Uint8Array>;
```

One `Duplex` invocation carries **one logical call**: the caller emits bytes,
the peer yields bytes back. Because both sides have the same shape, an
in-process test can wire `const caller = handler` and run with no transport at
all.

Iterator semantics carry every signal, which is why no separate close/abort API
exists:

| Signal | Mechanism |
| --- | --- |
| Consumer is done early | `.return()` on the output → producer's `finally` runs |
| Producer failed | `throw` → consumer's `for await` throws |
| Either side finished normally | Normal exhaustion → matching end on the other side |

`Connect<P>` and `Serve<P>` are the adapter-side factories that stand up a
transport and produce or register a `Duplex`.

> **Caller obligation.** Either drain the returned generator or `.return()` it.
> Dropping the reference without doing either emits no observable signal: the
> abandoned consumer never acknowledges inbound data, so the peer's outbound
> pump blocks awaiting that acknowledgement, no end-of-stream is exchanged, and
> both peers hold the stream open. An unreferenced generator is not observable,
> so no transport can detect this for you.

## `emulateMux`

Turns one `ByteChannel` — anything with `send` / `recv` / `closed` / `close` —
into many concurrent `Duplex` calls. Used by the MessagePort, WebSocket,
LiveKit, PeerJS and signaling adapters; transports with native multiplexing
(libp2p) don't need it.

```ts
import { emulateMux } from "@statewalker/webrun-streams";

const { call, serve, close } = emulateMux(channel, { side: "initiator" });

// caller side
const response = call([new TextEncoder().encode("ping")]);
for await (const chunk of response) { /* … */ }

// responder side
const stop = serve(async function* handler(input) {
  for await (const chunk of input) yield chunk; // echo
});
```

| Option | Default | Purpose |
| --- | --- | --- |
| `side` | `"initiator"` | Id allocation: initiator uses even ids, responder odd. Pick one per peer so they cannot collide. |
| `maxStreams` | `256` | Concurrent streams before new calls are refused. |
| `mtu` | `65536` | Largest payload per DATA frame; bigger chunks are split. |
| `maxStreamBuffer` | `8388608` | The credit this side advertises to the peer, in bytes, and the hard cap on inbound bytes one stream may hold undrained. A peer that honours credit never reaches the cap; one that ignores it has that stream torn down. |

### Flow control

Receiver-advertised credit. Each side puts its `maxStreamBuffer` in the frame it
opens with — `OPEN` for the caller, the `ACK` answering it for the responder —
and the sender may only send what it has been granted. Both sides start at zero,
so a caller pays one round trip per stream before its first DATA frame and none
thereafter. The receiver grants more once its consumer has actually drained,
batched at half the window and flushed as soon as its queue empties. A sender
therefore cannot overrun the receiver's buffer, and `maxStreamBuffer` bounds only
peers that ignore the protocol.

Backpressure is **per-stream**, so a stalled stream does not block the others,
and it applies symmetrically in both directions.

There is deliberately **no stall timeout**: a peer that never acknowledges
blocks that producer indefinitely, exactly as a TCP receiver that never reads
blocks its sender. `maxStreams` and `maxStreamBuffer` bound what that can cost.
The bound is per stream and there is no mux-wide budget, so the worst case is
`maxStreams × maxStreamBuffer` — 2 GiB at the defaults, against 16 MiB under the
one-frame-in-flight rule this replaced. Lower `maxStreamBuffer` if that matters
more than throughput.

### Behaviour on hostile input

A `ByteChannel` is message-oriented, so frames are discrete and a corrupt one
cannot desync the next. A frame that cannot be parsed is therefore **dropped**
rather than failing the connection — otherwise one malformed frame would tear
down every stream sharing the mux. A stream that exceeds `maxStreamBuffer` is
torn down on its own, with an error frame sent to the peer.

## Exports

Everything is exported from the package root.

### Seam types

| Export | Kind | Purpose |
| --- | --- | --- |
| `Duplex` | type | `(input) => AsyncGenerator<Uint8Array>` — one logical call. |
| `Connect<P>` | type | `(params) => Promise<{ call: Duplex; close() }>`. |
| `Serve<P>` | type | `(params, handler) => Promise<() => Promise<void>>`. |
| `ByteChannel` | type | `{ send, recv, closed, close }` — the minimum a transport must expose. |
| `ByteLike` | type | Accepted byte inputs before normalisation. |
| `emulateMux(channel, opts?)` | function | Multi-stream over a single `ByteChannel`. |
| `EmulateMuxOptions` | type | `maxStreams` (256), `mtu` (64 KiB), `maxStreamBuffer` (8 MiB), `side`. |
| `TransportClosedError` | class | Thrown when the transport closes with calls in flight. Catch via `instanceof` or `error.name`. |

### Credit

| Export | Kind | Purpose |
| --- | --- | --- |
| `newCreditLedger(initial?)` | function | Sender-side credit: `reserve(upTo)` waits for any credit and returns how much it got (`upTo` must be >= 1; less rejects with a `RangeError`), `grant(units)` releases waiters in order, `fail(err)` unwinds them. Starts at zero unless told otherwise. |
| `CreditLedger` | type | `{ available, reserve, grant, fail }`. |
| `newCreditGrantor(window, threshold?)` | function | Receiver-side: `consumed(units, queueEmpty)` returns the credit to hand back, batched at `threshold` (default half the window) and flushed once the queue empties. |
| `CreditGrantor` | type | `{ consumed(units, queueEmpty): number }`. |

The unit is whatever the caller counts. `emulateMux` counts bytes; a value-
oriented caller would count values. Nothing in this module interprets it.

### Message passing

| Export | Kind | Purpose |
| --- | --- | --- |
| `MessageTarget` | interface | Full-duplex structural view of a message endpoint — a `MessagePort`, a `Worker`, or a ServiceWorker bridge. Extends `MessageSource` and `MessageSink`. |
| `MessageSource` | interface | `addEventListener`/`removeEventListener` for `"message"`, plus optional `start()`. |
| `MessageSink` | interface | `postMessage(message, transfer?)`. |
| `MessageListener` | type | `(event: MessageEvent) => void \| Promise<void>`. |

These are types only — no runtime code — so `webrun-streams` keeps zero
dependencies. They live here rather than in `webrun-streams-port` so packages
that are not port-specific can use them without depending on that adapter.
A `MessagePort` satisfies `MessageTarget` structurally; no adapter is needed.

### Collectors and codecs

| Export | Purpose |
| --- | --- |
| `collect` / `collectBytes` / `collectString` | Drain an async iterable to an array / `Uint8Array` / `string`. |
| `encodeText` / `decodeText` | UTF-8 `string` ↔ `Uint8Array` streams. |
| `splitLines` / `joinLines` | Cross-chunk-safe line splitting and rejoining. |
| `encodeJsonl` / `decodeJsonl` | JSON values ↔ `\n`-delimited string stream. |
| `map` | Stream-map over an `AsyncIterable<T>`. |
| `toChunks` / `normalizeToUint8Array` | Coerce assorted byte-ish inputs into `Uint8Array` chunks. |

### Iterator plumbing

| Export | Purpose |
| --- | --- |
| `newAsyncGenerator` | Backpressure-aware queue turning `next`/`done` callbacks into an async generator. |
| `sendIterator` / `recieveIterator` | Ship an async iterator across any transport. |
| `IteratorChunk` | type — the `{ done, value, error }` chunk envelope they exchange. |
| `ChunkSender` / `ChunkReceiver` / `ReceiverInstaller` | types — the transport-side callbacks those two are wired to. |
| `toReadableStream` / `fromReadableStream` | `AsyncIterator<Uint8Array>` ↔ WHATWG `ReadableStream<Uint8Array>`. |

### Errors

| Export | Purpose |
| --- | --- |
| `serializeError` / `deserializeError` | Preserve `message`, `stack` and custom fields across JSON / structured-clone boundaries. |
| `SerializedError` | type — the wire shape those two produce and consume. |

## Internals

### `newAsyncGenerator` — backpressure queue

A singly-linked queue of slots; each slot carries either a value or a
terminal `{done: true, error?}`. Producers call `next(value)` or
`done(error?)`, both returning `Promise<boolean>` that resolves once the
consumer has dequeued the slot — so producers can apply backpressure by
`await`ing.

If the consumer breaks out of the `for await` early, the finally block
drains remaining slots and resolves each pending `next/done` promise
with `false`, letting the producer observe that its value wasn't
consumed and stop. Cleanup function (if the `init` returned one) runs
on the same exit path.

`skipValues: true` switches the queue into latest-only mode: pushing a
new value drops any unconsumed older ones. Useful for "show the most
recent state" scenarios (live previews, resizing, etc.) where missing
values is fine but lagging isn't.

### Chunk protocol

One object per message:

```
{ done: false, value: T }   — a value
{ done: true,  error?: E }  — termination (error if present rethrows)
```

`sendIterator` guarantees exactly one `done` chunk and never throws
itself — errors from the source iterator end up in the trailing chunk's
`error` field. `recieveIterator` rethrows them into the `for await`
loop on the other side.

### `readable-streams`

`toReadableStream` uses the default (non-byte) ReadableStream type to
sidestep the strict `ArrayBuffer`-not-`SharedArrayBuffer` typing the
byte-controller requires in recent TS libs. Both functions are
strict one-way converters: no queuing strategy tricks, no transform.

### Design notes

- **Zero runtime dependencies.** Only platform builtins
  (`Promise`, `ReadableStream`, `TextEncoder`/`Decoder` if needed,
  `setTimeout` via `newAsyncGenerator` consumers).
- **British/American spelling kept.** `recieveIterator` uses the
  historical misspelling to stay wire-compatible with `webrun-ports`
  consumers.
- **No tight coupling to any transport.** `ByteChannel` is the only
  transport-facing type, and it is an interface — nothing here mentions
  `MessagePort`, `WebSocket`, `fetch`, `Worker`, etc. Those belong to the
  `webrun-streams-*` adapters, each of which supplies a `ByteChannel` and lets
  `emulateMux` do the rest.

### Constraints

- `toReadableStream` / `fromReadableStream` assume `Uint8Array` chunks —
  the usual shape for HTTP bodies. Generic byte-agnostic use isn't
  supported.
- `newAsyncGenerator`'s backpressure Promise resolves with `false` both
  on early break and on skip; consumers can't distinguish the two.
  That's intentional — both mean "wasn't consumed".

### Dependencies

**Zero runtime dependencies.**

Dev: TypeScript, vitest, rolldown, rimraf, `@types/node`
(catalog versions from the monorepo root).

## Scripts

```sh
pnpm test        # vitest run
pnpm run build   # rolldown + tsc --emitDeclarationOnly (ships src + dist)
pnpm lint        # biome check
```

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
