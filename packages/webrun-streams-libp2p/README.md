# @statewalker/webrun-streams-libp2p

libp2p native multi-stream `Connect` / `Serve` adapter. Each `call(input)` opens a new libp2p `Stream` via `node.dialProtocol(peer, [protocol])`; the responder registers via `node.handle(protocol, ...)`. Default protocol id: `/webrun-streams/1.0.0`.

libp2p streams are already source/sink shaped, and yamux gives credit-window backpressure plus head-of-line avoidance for free. The adapter adds a small framing on top (`[type:1][length:varint][payload]`, types `DATA` and `ERROR`) so that handler errors survive the wire — yamux's native `StreamResetError` discards the error message.

```ts
import { connect, serve } from "@statewalker/webrun-streams-libp2p";

const { call } = await connect({ node, peer, protocol: "/my-app/1.0.0" });
const stop = await serve({ node, protocol: "/my-app/1.0.0" }, handler);
```

## Conformance

The conformance suite is opt-in because it spins up two real libp2p TCP nodes in-process:

```bash
WEBRUN_STREAMS_LIBP2P=1 pnpm test
```

## License

MIT
