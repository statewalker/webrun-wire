# @statewalker/webrun-streams-webrtc

WebRTC native multi-stream `Connect` / `Serve` adapter. Each `call(input)` opens a fresh `RTCDataChannel` on the supplied `RTCPeerConnection`; the responder listens on `pc.ondatachannel`.

DataChannels have no native half-close, so the adapter carries a tiny 1-byte frame protocol inside each DC message: `DATA` (0x00, body bytes), `END` (0x01, half-close), `ERROR` (0x02, serialised error). Outbound bytes are chunked at 16 KiB.

```ts
import { connect, serve } from "@statewalker/webrun-streams-webrtc";

const { call } = await connect({ pc });          // RTCPeerConnection
const stop = await serve({ pc }, handler);
```

## License

MIT
