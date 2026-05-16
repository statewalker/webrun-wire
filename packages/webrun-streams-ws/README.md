# @statewalker/webrun-streams-ws

WebSocket-backed `Connect` / `Serve` adapter in the `webrun-streams-*` family. Each `WebSocket` is one byte channel; `emulateMux` provides the multi-stream layer on top.

```ts
import { connect, serve } from "@statewalker/webrun-streams-ws";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });
const stop = await serve(
  { onConnection: (cb) => { wss.on("connection", cb); return () => wss.off("connection", cb); } },
  async function* (input) { for await (const c of input) yield c; },
);

const { call } = await connect({ url: "ws://localhost:8080", WebSocketCtor: NodeWebSocket });
```

## Conformance

Passes every level of `@statewalker/webrun-streams-conformance` against an in-process `WebSocketServer`.

## License

MIT
