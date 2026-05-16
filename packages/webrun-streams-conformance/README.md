# @statewalker/webrun-streams-conformance

Conformance suite for `Duplex` / `Connect` / `Serve` adapters in the `webrun-streams-*` family. Every adapter ships a one-line test file that calls `describeDuplexAdapter(name, makePair)` with its own pair factory.

## Levels asserted

- **L0** Envelope round-trip via an echo handler for body sizes empty / 1 KiB / 1 MiB / 10 MiB.
- **L1** N concurrent calls (default 10) with correct per-call body identity.
- **L2** Half-close — caller exhausts input; handler keeps yielding response chunks.
- **L3** Mid-stream cancellation — caller `.return()`s output; handler's `finally` runs.
- **L4** Error propagation — handler `throw`s; caller sees `message` + `stack` + custom fields preserved.
- **L5** Transport teardown — `close()` mid-flight; calls fail with a defined error class; `serve` teardown idempotent.

## Reference loopback

`makeLoopbackPair()` returns a `ConnectServePair` whose `call` invokes the registered `handler` directly with no transport. The suite must pass green against the loopback — this is the self-test that the assertions are correctly formulated.

## Usage

```ts
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { makeMyAdapterPair } from "./make-pair.js";

describeDuplexAdapter("my-adapter", makeMyAdapterPair);
```

## License

MIT
