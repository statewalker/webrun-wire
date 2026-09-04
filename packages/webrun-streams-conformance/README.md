# @statewalker/webrun-streams-conformance

Conformance suite for `Duplex` / `Connect` / `Serve` adapters in the `webrun-streams-*` family. Every adapter ships a one-line test file that calls `describeDuplexAdapter(name, makePair)` with its own pair factory.

## Why it exists

The promise of the [`webrun-streams`](../webrun-streams) seam is that a handler
written once runs over *any* transport. That promise is only as good as the
weakest adapter — and the failure modes that break it are the quiet ones: an
adapter that works for small bodies but truncates at 10 MiB, that serialises
concurrent calls, that drops a handler's `finally` on cancellation, or that
turns a thrown `Error` into an anonymous disconnect.

None of those show up in an adapter's own happy-path tests. This package makes
them a shared, executable definition of "correct", so a new transport is a
day's work rather than a new set of subtle incompatibilities.

## Install

```sh
npm install --save-dev @statewalker/webrun-streams-conformance
```

It is a **test-time** dependency: it bundles `vitest` and defines suites via
`describe` / `it`.

## Levels asserted

- **L0** Envelope round-trip via an echo handler for body sizes empty / 1 KiB / 1 MiB / 10 MiB.
- **L1** N concurrent calls (default 10) with correct per-call body identity.
- **L2** Half-close — caller exhausts input; handler keeps yielding response chunks.
- **L3** Mid-stream cancellation — caller `.return()`s output; handler's `finally` runs.
- **L4** Error propagation — handler `throw`s; caller sees `message` + `stack` + custom fields preserved.
- **L5** Transport teardown — calling the `serve` teardown twice resolves rather than throwing, and closing the pair after a completed call resolves cleanly. (It does *not* assert what an in-flight call does when the transport closes underneath it; that is deliberately left to each adapter.)
- **L6** Flow control — a 256 KiB body reaches a deliberately slow consumer intact through a 16 KiB advertised window, so the sender must exhaust its credit and resume on grants sixteen times over. Adapters that accept `mux` options can run it at that window; today that is `-ws` and `-port`, the only two with an executable conformance run. `-peerjs` and `-livekit` accept the option but have no pair helper yet, so L6 does not run for them. The loopback, `-webrtc` and `-libp2p` have no `emulateMux` to tune, so for them it is an end-to-end integrity check and nothing more.

## Reference loopback

`makeLoopbackPair()` returns a `ConnectServePair` whose `call` invokes the registered `handler` directly with no transport. The suite must pass green against the loopback — this is the self-test that the assertions are correctly formulated.

## Usage

```ts
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { makeMyAdapterPair } from "./make-pair.js";

describeDuplexAdapter("my-adapter", makeMyAdapterPair);
```

`makeMyAdapterPair` is a `MakePair` — an async factory returning a
`ConnectServePair` (`connect()`, `serve(handler)`, `close()`). It is called
once per test case, so each gets a fresh transport.

A third argument tunes the suite:

| Option | Default | Effect |
| --- | --- | --- |
| `concurrency` | `10` | How many concurrent calls L1 runs. |
| `skipHugeBody` | `false` | Drop L0's 10 MiB case, for transports that rate-limit. |

## API

| Export | Kind | Purpose |
| --- | --- | --- |
| `describeDuplexAdapter(name, makePair, options?)` | function | Registers the whole L0–L6 suite for one adapter. |
| `makeLoopbackPair()` | `MakePair` | The reference in-process pair; the suite's own self-test. |
| `MakePair` | type | `(tuning?: PairTuning) => Promise<ConnectServePair>` — called once per test case. |
| `ConnectServePair` | type | `{ connect(), serve(handler), close() }`. |
| `PairTuning` | type | `{ mtu?, maxStreamBuffer? }` — flow-control window L6 asks a pair for; an adapter that can forward it to `emulateMux` should. |
| `DescribeDuplexAdapterOptions` | type | `concurrency` (default 10), `skipHugeBody` (default false). |

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` seam under test. |
| `vitest` | runtime | The suite is defined with `describe` / `it`. |

Consumed as a `devDependency` by every adapter in the family. ESM only
(`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
