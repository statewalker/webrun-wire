# @statewalker/webrun-msgpack

Length-prefixed MessagePack frame codec for async iterables. Streams-safe `encode`/`decode` for arbitrary values, plus zero-copy specialisations for `Float32Array`.

## Why it exists

Consumers that pipe values across transports (scanners writing chunks to a store, chat pipelines streaming embeddings, etc.) need a way to serialise a stream of objects into a byte stream and reassemble it on the other side without truncation surprises.

A raw MessagePack stream has no frame boundaries: a decoder can only succeed if the chunk boundaries happen to line up with the payload boundaries. Length-prefix framing fixes this — the decoder buffers incoming bytes and only yields when a complete `[length][payload]` pair is available. Partial trailing frames are NEVER emitted, so callers can detect truncation by comparing observed count to expected.

Previously the codec lived inside `@repo/streams` (private, unpublished). It's been extracted here so (a) consumers that only need framing don't pull in the broader `webrun-streams` surface, and (b) the `@ygoe/msgpack` dependency lives in exactly one place.

## How to use

```sh
npm install @statewalker/webrun-msgpack
```

Four exports — one encode/decode pair for generic values, one for `Float32Array`:

| Export | Direction | Use case |
| --- | --- | --- |
| `encodeMsgpack<T>(src: AsyncIterable<T>)` | values → bytes | generic JSON-ish values |
| `decodeMsgpack<T>(src: AsyncIterable<Uint8Array>)` | bytes → values | inverse of `encodeMsgpack` |
| `encodeFloat32Arrays(src: AsyncIterable<Float32Array>)` | arrays → bytes | zero-copy float streaming |
| `decodeFloat32Arrays(src: AsyncIterable<Uint8Array>)` | bytes → arrays | inverse of `encodeFloat32Arrays` |

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

### Decoder state machine

The decoder keeps a rolling `Uint8Array` buffer. Each incoming chunk is appended (single allocation per chunk); then:

1. If buffer is shorter than 4 bytes — wait for more.
2. Read the 32-bit BE length.
3. If buffer doesn't hold `4 + length` bytes — wait for more.
4. Slice the payload, deserialise with `@ygoe/msgpack`, yield.
5. Advance the buffer past this frame; repeat step 1.

Zero-length chunks are tolerated and simply no-op through the loop. Truncated trailing frames are silently dropped — the buffer retains them but the consuming `for await` ends without yielding a partial value.

### Float32Array zero-copy

`encodeFloat32Arrays` constructs a `Uint8Array` view over the `Float32Array`'s underlying buffer and serialises it as a msgpack `bin` payload — no float-by-float conversion. `decodeFloat32Arrays` reinterprets the decoded `Uint8Array` as a `Float32Array`. When the decoded buffer's `byteOffset` is not 4-byte aligned (can happen if `@ygoe/msgpack` returns a view into a larger buffer), we copy into a fresh aligned `Uint8Array` before constructing the `Float32Array`; otherwise the operation is view-only.

### Dependencies

- [`@ygoe/msgpack`](https://github.com/ygoe/msgpack.js) — single-file msgpack implementation (≈7 kB gzipped), no transitive deps.

Dev: TypeScript, vitest, tsdown, rimraf (catalog versions from the monorepo root).

### Constraints

- Big-endian length prefix only — no little-endian variant.
- `decodeMsgpack` allocates one `Uint8Array` per incoming chunk for the `concat`; long streams with many tiny chunks may benefit from a batched source upstream.
- `Float32Array` codec is strictly `Float32` — no element-size negotiation.

## Scripts

```sh
pnpm test        # vitest run (25 tests)
pnpm run build   # tsdown
pnpm lint        # biome check
```

## License

MIT © statewalker
