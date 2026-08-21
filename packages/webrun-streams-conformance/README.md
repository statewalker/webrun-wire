# @statewalker/webrun-streams-conformance

Conformance suite for `Duplex` / `Connect` / `Serve` adapters in the `webrun-streams-*` family. Every adapter ships a one-line test file that calls `describeDuplexAdapter(name, makePair)` with its own pair factory.

## Levels asserted

- **L0** Envelope round-trip via an echo handler for body sizes empty / 1 KiB / 1 MiB / 10 MiB.
- **L1** N concurrent calls (default 10) with correct per-call body identity.
- **L2** Half-close — caller exhausts input; handler keeps yielding response chunks.
- **L3** Mid-stream cancellation — caller `.return()`s output; handler's `finally` runs.
- **L4** Error propagation — handler `throw`s; caller sees `message` + `stack` + custom fields preserved.
- **L5** Transport teardown — calling the `serve` teardown twice resolves rather than throwing, and closing the pair after a completed call resolves cleanly. (It does *not* assert what an in-flight call does when the transport closes underneath it; that is deliberately left to each adapter.)

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

## License

MIT
