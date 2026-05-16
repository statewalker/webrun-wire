# @statewalker/webrun-streams-libp2p

libp2p native multi-stream `Connect` / `Serve` adapter. Each `call(input)` opens a new libp2p `Stream` via `node.dialProtocol(peer, [protocol])`; the responder registers via `node.handle(protocol, ...)`. Default protocol id: `/webrun-streams/1.0.0`.

The thinnest adapter in the family — libp2p streams are already source/sink shaped, and yamux gives credit-window backpressure plus head-of-line avoidance for free.

```ts
import { connect, serve } from "@statewalker/webrun-streams-libp2p";

const { call } = await connect({ node, peer, protocol: "/my-app/1.0.0" });
const stop = await serve({ node, protocol: "/my-app/1.0.0" }, handler);
```

## License

MIT
