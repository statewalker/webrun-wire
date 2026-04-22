# @statewalker/webrun-streams

Async-iterator and `ReadableStream` primitives: `collect` / `collectBytes` / `collectString`, text and JSONL codecs, line splitting/joining, a backpressure-aware queue-based generator, a chunk protocol for pushing iterators across transports, conversions between async iterators and WHATWG `ReadableStream<Uint8Array>`, and serialisable `Error` objects.

## Why it exists

Every higher-level package in the `webrun-*` family (and its consumers — scanners, indexers, chat pipelines) needs the same small set of building blocks:

1. **Collectors** — turn any async iterable into a concrete array / `Uint8Array` / `string` without boilerplate; zero-copy short-circuit when a single chunk is produced.
2. A **callback-to-async-iterator** bridge — turn incoming `{done, value, error}` callbacks into a `for await` loop, with backpressure so producers know when consumers have stopped listening.
3. A **chunk protocol** — a tiny `{done, value?, error?}` envelope that can travel across any transport (MessagePort, WebSocket, IPC, in-memory) and rebuild the original iterator on the other side.
4. **WHATWG ↔ async-iterator** conversions for body bytes, so code written against `fetch` (`ReadableStream<Uint8Array>`) can interoperate with `for await` code and back.
5. **Error (de)serialisation** for passing exceptions across structured-clone / JSON boundaries without losing stacks or extra fields.
6. **Line / JSONL / text codecs** so stream-processing code doesn't re-invent split/join/encode/decode in every consumer.

The MessagePack codec that previously rode along here is split out to [`@statewalker/webrun-msgpack`](../webrun-msgpack) so consumers that don't need framing don't pull in `@ygoe/msgpack`.

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

const values = decodeJsonl<{ a: number }>(splitLines(decodeText(chunks())));
for await (const v of values) console.log(v); // { a: 1 }

// inverse
const jsonl = encodeText(joinLines(encodeJsonl([{ a: 1 }, { a: 2 }])));
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
import { sendIterator, recieveIterator } from "@statewalker/webrun-streams";

// Drain an iterable across any transport.
async function transport<T>(chunk: { done: boolean; value?: T; error?: unknown }) {
  // …send `chunk` over your channel.
}
await sendIterator(transport, [1, 2, 3]);

// On the other side, rebuild the original iterator.
const iter = recieveIterator<number>((deliver) => {
  myChannel.onMessage = (chunk) => deliver(chunk);
});
for await (const v of iter) console.log(v); // 1, 2, 3
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
- **No tight coupling to any transport.** Nothing here mentions
  `MessagePort`, `fetch`, `Worker`, etc. Those belong to the consuming
  packages.

### Constraints

- `toReadableStream` / `fromReadableStream` assume `Uint8Array` chunks —
  the usual shape for HTTP bodies. Generic byte-agnostic use isn't
  supported.
- `newAsyncGenerator`'s backpressure Promise resolves with `false` both
  on early break and on skip; consumers can't distinguish the two.
  That's intentional — both mean "wasn't consumed".

### Dependencies

**Zero runtime dependencies.**

Dev: TypeScript, vitest, tsdown, rimraf, `@types/node`
(catalog versions from the monorepo root).

## Scripts

```sh
pnpm test        # vitest run
pnpm run build   # tsdown (publishes src + compiled dist)
pnpm lint        # biome check
```

## License

MIT © statewalker
