# @statewalker/webrun-streams-port

Two layers on the same `MessagePort`:

- **`Duplex` / `Connect` / `Serve` tier** — byte streams multiplexed via `emulateMux`. Use for Worker / SharedWorker / ServiceWorker comms where you want the canonical `Duplex` seam.
- **Typed-JSON RPC tier** — `callPort` / `listenPort` / `callBidi` / `listenBidi` / `ioSend` / `ioHandle` re-exported from the legacy `webrun-ports` package. Use when you want typed JSON arguments per call and don't need byte-stream semantics.

```ts
import { connect, serve } from "@statewalker/webrun-streams-port";

const channel = new MessageChannel();
const server = await serve({ port: channel.port2 }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});
const { call } = await connect({ port: channel.port1 });
```

## Conformance

Passes every level of `@statewalker/webrun-streams-conformance` against a `MessageChannel` pair.

## License

MIT
