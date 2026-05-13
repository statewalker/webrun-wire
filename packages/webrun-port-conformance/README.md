# @statewalker/webrun-port-conformance

Conformance test suite for bridged `MessagePort` adapters in the `webrun-port-*` family. Every adapter (`webrun-port-ws`, `webrun-port-webrtc`, `webrun-port-libp2p`, `webrun-port-peerjs`, `webrun-port-livekit`) ships a one-line test file that calls `describePortAdapter` with its own `makePair` factory.

The suite covers the three layers of the bridged-port contract documented in `@statewalker/webrun-port-core`:

- **L0** — port semantics (`postMessage` round-trip, close propagation).
- **L1** — bridged constraints (byte payloads, structured-cloneable envelopes, ordering, transparent chunking up to 10 MB).
- **L2** — framework composition (`callBidi` / `listenBidi` round-trip, 10 concurrent calls, 10 MB `ioSend` / `ioHandle` stream).

## Usage

```ts
import { describePortAdapter } from "@statewalker/webrun-port-conformance";
import { makeMyAdapterPair } from "./make-pair.js";

describePortAdapter("my-adapter", makeMyAdapterPair, {
  // optional: enable failure-mode tests with a faulty-pair factory
  // makeFaultyPair: makeMyFaultyAdapterPair,
});
```

The `MakePair` factory returns `{ a, b, close }` — two `MessagePort`s connected through the adapter's transport and a teardown function. The suite uses the pair to run every conformance scenario.

## Reference loopback

`makeLoopbackPair` returns a pair backed by a single `new MessageChannel()`. The suite must pass against it — this is the self-test of the suite itself. New conformance scenarios should be validated against loopback before being shipped.

## Running

- `pnpm test` — Node mode. Default. Should always pass for every adapter that targets Node.
- `pnpm test:browser` — Vitest browser mode (Playwright + Chromium). Requires `@vitest/browser` and `playwright` installed at the workspace level, and `pnpm playwright install chromium` to have been run once.

## License

MIT
