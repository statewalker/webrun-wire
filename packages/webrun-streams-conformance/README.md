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
| `PairTuning` | type | `{ mtu?: number; maxStreamBuffer?: number }`. The flow-control window L6 asks for. No remaining adapter has such a window, so pairs ignore it; see L6 below. |
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
    connect: () => connect({ mux: overPipe(port1, { codec, side: "initiator" }) }),
    serve: (handler) => serve({ mux: overPipe(port2, { codec, side: "responder" }) }, handler),
    close: async () => {
      port1.close();
      port2.close();
    },
  };
};
```

The factory may take the suite's `tuning` argument and forward it if the
adapter has a matching window; a port-stack pair has none and leaves it out.

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

### L6 is an integrity check on every current pair

L6 was written for a credit-window multiplexer, `emulateMux` (removed from
`@statewalker/webrun-streams` in Plan C3). At its default window (8 MiB) a
256 KiB body never exhausted credit, so the test asked the pair for a 16 KiB
window, which made the sender run out of credit and resume on grants sixteen
times; without grants the transfer hung, and without credit reservation the
receiver's buffer cap tore the stream down.

No remaining adapter has that window. Pairs on `@statewalker/webrun-rpc`'s port
stack ignore `tuning` (`webrun-rpc`'s own `connect` / `serve` run maps `mtu` to
`maxMessageSize`, which only changes how the body is chunked), and adapters
that multiplex natively ignore it too. For all of them L6 checks that a 256 KiB
body reaches a slow consumer intact and in order, and nothing more: it does not
prove flow control. Each stack measures its own backpressure in its own tests.
A later change (spec D17) redefines L6 and `PairTuning`.

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
