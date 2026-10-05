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
| `ConnectServePair` | type | `{ connect(): Promise<{ call: Duplex; close(): Promise<void> }>; serve(handler: Duplex): Promise<() => Promise<void>>; close(): Promise<void> }`. |
| `PairTuning` | type | `{ mtu?: number; maxStreamBuffer?: number }`. The flow-control window L6 asks for. |
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

A pair factory stands up both ends of one transport and forwards the tuning to
the adapter if it can. For an adapter built on `emulateMux`, the tuning maps
directly onto its options:

```ts
// tests/make-pair.ts
import { type ByteChannel, emulateMux } from "@statewalker/webrun-streams";
import type { MakePair } from "@statewalker/webrun-streams-conformance";

declare function makeChannelPair(): { a: ByteChannel; b: ByteChannel };

export const makeMyAdapterPair: MakePair = async (tuning) => {
  const { a, b } = makeChannelPair();
  const client = emulateMux(a, { side: "initiator", ...tuning });
  const server = emulateMux(b, { side: "responder", ...tuning });
  return {
    connect: async () => ({ call: client.call, close: async () => {} }),
    serve: async (handler) => server.serve(handler),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};
```

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
| L6 | Flow control: a 256 KiB body reaches a consumer that waits 1 ms per chunk, intact and in order, through `{ mtu: 4096, maxStreamBuffer: 16384 }`. |

### Why L6 uses a small window and a slow consumer

At an adapter's default window (8 MiB for `emulateMux`) a 256 KiB body never
exhausts credit, so no sender stalls and no grant is sent, and the test would
pass with flow control removed. A 16 KiB window against a 256 KiB body makes
the sender run out of credit and resume on grants sixteen times. The test
itself checks completion and integrity; stalling and replenishment are covered
by elimination: without grants the transfer hangs and the test times out;
without credit reservation the sender floods the window and the receiver's
buffer cap tears the stream down.

An adapter that multiplexes natively, or has no configurable window, ignores
`tuning`. For it, L6 is an integrity check at the adapter's own defaults and
nothing more.

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
