# @statewalker/webrun-streams-peerjs

PeerJS DataConnection-backed `Connect` / `Serve` adapter. Wraps a `DataConnection` (which itself wraps a WebRTC DataChannel) into a byte channel; `emulateMux` provides multi-stream. Requires `serialization: "raw"` on the connection.

```ts
import { connect, serve } from "@statewalker/webrun-streams-peerjs";

const { call } = await connect({ conn });        // open DataConnection
const stop = await serve({ peer }, handler);    // listens for inbound conns
```

Conformance is browser-gated; PeerJS's WebRTC handshake hangs under Node's wrtc polyfill. Run with `pnpm test:browser`.

## License

MIT
