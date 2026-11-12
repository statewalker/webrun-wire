# @statewalker/webrun-streams-conformance

## What it is

A Vitest suite that checks a transport adapter against the `Duplex` /
`Connect` / `Serve` seam from `@statewalker/webrun-streams`. An adapter calls
`describeDuplexAdapter(name, makePair)` from one test file, with a factory that
stands up a fresh client/server pair, and gets seven levels of checks (L0 to
L6): large bodies, concurrency, half-close, cancellation, error propagation,
teardown and flow control. It also ships `makeLoopbackPair`, a pair with no
transport at all, which the suite must pass against.

## Why it exists

The seam promises that a handler written once runs over any transport. That
holds only as far as the weakest adapter, and the failures that break it are
quiet ones: an adapter that works for small bodies but truncates at 10 MiB,
serialises concurrent calls, skips a handler's `finally` on cancellation, or
turns a thrown `Error` into an anonymous disconnect. An adapter's own
happy-path tests do not catch these. This package makes them one shared,
executable definition of "correct" that every adapter runs.

## How to use

```sh
pnpm add -D @statewalker/webrun-streams-conformance
```

It is a test-time dependency. It imports `describe`, `it` and `expect` from
`vitest`, so `describeDuplexAdapter` must be called from a file Vitest is
running. Runtime dependencies: `@statewalker/webrun-streams` and `vitest`. No
peer dependencies. One entry point, `.`.

| Export | Kind | What it gives |
| --- | --- | --- |
| `describeDuplexAdapter(name, makePair, options?)` | function | Registers L0 to L6 under `describe("<name> — Duplex conformance")`. |
| `makeLoopbackPair` | `MakePair` | Reference pair: `call` invokes the registered handler directly. |
| `MakePair` | type | `(tuning?: PairTuning) => Promise<ConnectServePair>`. Called once per test case, so each case gets a fresh transport. |
| `ConnectServePair` | type | `{ connect(): Promise<{ call: Duplex; close(): Promise<void> }>; serve(handler: Duplex): Promise<() => Promise<void>>; close(): Promise<void>; runAheadBytes?: number }`. `runAheadBytes` is the most bytes a producer may get ahead of a consumer that stopped reading; L6 asserts it (see below). |
| `PairTuning` | type | `{ maxMessageSize?: number }`. L6 asks for 4 KiB, so its 256 KiB body crosses as many messages; a pair whose transport decides its own ceiling ignores it. |
| `measureRunAhead(makePair, direction)` | function | L6's run-ahead measurement, for one direction: resolves `{ bound, ahead, complete, intact }`. |
| `RunAheadMeasurement` | type | What `measureRunAhead` resolves. |
| `DescribeDuplexAdapterOptions` | type | `{ concurrency?: number; skipHugeBody?: boolean }`. |

| Option | Default | Effect |
| --- | --- | --- |
| `concurrency` | `10` | How many concurrent calls L1 runs. |
| `skipHugeBody` | `false` | Drop L0's 10 MiB case, for transports that rate-limit or are slow. |

## Examples

### Run the suite against an adapter

```ts
// tests/conformance.test.ts
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { makeMyAdapterPair } from "./make-pair.js";

describeDuplexAdapter("my-adapter", makeMyAdapterPair, { skipHugeBody: true });
```

### Write a pair factory

A pair factory stands up both ends of one transport. Most adapters are a pipe
for `@statewalker/webrun-rpc`'s port stack, so the factory runs `overPipe` and
`webrun-rpc`'s `connect` / `serve` over that pipe. Here the pipe is a
`MessageChannel`; a real adapter puts its own pipe (and its `signal` and
`maxMessageSize`) in its place:

```ts
// tests/make-pair.ts
import { connect, overPipe, serve, structuredCodec } from "@statewalker/webrun-rpc";
import type { MakePair } from "@statewalker/webrun-streams-conformance";

export const makeMyAdapterPair: MakePair = async () => {
  const { port1, port2 } = new MessageChannel();
  const codec = structuredCodec;
  return {
    runAheadBytes: 8192, // the port stack: a producer is never more than a chunk ahead
    connect: () => connect({ mux: overPipe(port1, { codec, side: "initiator" }) }),
    serve: (handler) => serve({ mux: overPipe(port2, { codec, side: "responder" }) }, handler),
    close: async () => {
      port1.close();
      port2.close();
    },
  };
};
```

The factory may take the suite's `tuning` argument and pass `maxMessageSize`
on to `overPipe`. `runAheadBytes` declares the transport's buffering; leave it
out only if the transport has no known bound, and L6 then checks completion
alone (say why where the pair is declared).

### Check the suite itself

```ts
import { describeDuplexAdapter, makeLoopbackPair } from "@statewalker/webrun-streams-conformance";

describeDuplexAdapter("loopback", makeLoopbackPair);
```

## Internals

### What each level asserts

| Level | Assertion |
| --- | --- |
| L0 | An echo handler round-trips bodies of 0 B, 1 KiB, 1 MiB and 10 MiB byte for byte. |
| L1 | `concurrency` concurrent calls each get back their own body. |
| L2 | Half-close: after the caller's input ends, the handler keeps yielding (three chunks, 30 ms apart) and the caller receives all of them. |
| L3 | Mid-stream cancellation: the caller breaks out after 3 chunks of an endless response, and within 50 ms the handler's `finally` has run. |
| L4 | Error propagation: a handler that throws an `Error` with `status: 418` and `code: "TEAPOT"` makes the caller's `for await` reject with the same `message`, `status` and `code`, and a non-empty `stack`. |
| L5 | Teardown: calling the `serve` teardown twice resolves; `pair.close()` after a completed call resolves. |
| L6 | Flow control (spec D17): a 256 KiB body crosses as 4 KiB messages to a consumer that waits 1 ms per chunk, intact; and in each direction, a producer of 4 KiB chunks facing a consumer that stops after one chunk stalls within the pair's `runAheadBytes`, then finishes, every byte intact, once the consumer resumes. |

### L6 asserts how far a producer runs ahead (spec D17)

L6 used to ask a pair for a small credit window and check that a body crossed
it. That window was `emulateMux`'s (removed in Plan C3), and with no window to
shrink the level proved only integrity. Now each pair declares
`runAheadBytes`, the most a producer may get ahead of a consumer that has
stopped reading, and L6 measures it, in both directions. The producer yields
4 KiB chunks, enough to exceed the bound twice over; the consumer takes one and
stops; once the producer has produced nothing for a second, `produced −
consumed` must be at most the bound; then the consumer resumes, and every byte
must arrive in place (byte k belongs to chunk k / 4096, whatever chunk
boundaries the transport chose). `measureRunAhead(makePair, direction)` is the
measurement itself, exported; the package's own `tests/l6-self.test.ts` shows it
catches a transport that buffers without bound while pulling only every 150 ms,
and one that duplicates a chunk and drops another.

| Pair | `runAheadBytes` | Measured |
| --- | --- | --- |
| loopback | 0 | 0 |
| port stack (`webrun-rpc`, `msgpack` byte pipe, `-ws`, `-peerjs`, `-livekit`) | 4 KiB (one chunk) | 0: the next chunk is produced only once the consumer pulls past the last |
| `-webrtc` `connect` / `serve` | `RECEIVE_WINDOW` (4 MiB) + 16 KiB | 4 MiB exactly |
| `-webrtc` port stack (`webrtcPortMux`) | 4 KiB (one chunk) | 0 |
| `-libp2p` `connect` / `serve` | 2 × the receiving node's yamux window + 256 KiB | 1.06-1.13 MiB with a 1 MiB window (2.00 MiB reading and stalling by turns), 16.05-16.12 MiB with yamux's default 16 MiB (before the paced reader: 22-24 MiB, until libp2p's read buffer aborted the stream) |
| `-libp2p` port stack (native `libp2pPortMux`, or `overPipe` on one stream) | 4 KiB (one chunk) | 0 |

The level dies on what it should: sending port-stack chunks without waiting for
their confirmation fails it, a WebRTC pair declaring half its window fails it at
exactly 4 MiB ahead, and a libp2p pair whose reader never pauses fails it (its
`tests/run-ahead.test.ts`, with the other mutants listed in that package).

### What L5 deliberately does not assert

L5 does not check what an in-flight call does when the transport closes under
it. That behaviour differs between transports, and each adapter tests it
itself.

### Why the loopback pair exists

`makeLoopbackPair` has no wire protocol and no multiplexer, so a failure
against it is a bug in the assertions, not in a transport. After
`pair.close()`, or before a handler is registered, its `call` returns a
generator that throws `loopback: pair closed` or
`loopback: no handler registered`.

### Constraints

- Body bytes are a deterministic fill, not `crypto.getRandomValues`, which is
  limited to 64 KiB per call in browsers. The bytes only need to round-trip.
- Every test creates its own pair and closes it in a `finally`, so a factory
  must support being called many times in one file.

### Dependencies

- `@statewalker/webrun-streams` (`workspace:^`): the `Duplex` type and
  `collectBytes`.
- `vitest`: the suite is defined with `describe` / `it` / `expect`. It is a
  regular dependency, not a peer, so the consumer's Vitest and this package's
  should resolve to the same installed copy.

## License

MIT
