# @statewalker/webrun-streams-livekit

LiveKit-backed `Connect` / `Serve` adapter. Wraps a connected `Room` plus a participant identity into a byte channel; `emulateMux` provides multi-stream. `RELIABLE` publish mode is forced (ordered, retransmitted).

```ts
import { connect, serve } from "@statewalker/webrun-streams-livekit";

const { call } = await connect({ room, peerIdentity: "agent-7" });
const stop = await serve({ room, peerIdentity: "client-3" }, handler);
```

Conformance is browser-gated; run with `pnpm test:browser` plus `WEBRUN_STREAMS_LIVEKIT_*` env vars set against a running LiveKit server.

## License

MIT
