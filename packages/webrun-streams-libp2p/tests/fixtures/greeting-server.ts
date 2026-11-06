// Forked by dead-peer.test.ts, then SIGKILLed: a peer that dies without a word.
// Serves two protocols: per-stream calls that greet, drain their input and
// stay open; and one stream carrying a multiplexer whose ports stay open.
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { multiplexPort } from "@statewalker/webrun-rpc";
import { createLibp2p } from "libp2p";
import { serve } from "../../src/connect-serve.js";
import { messageTargetOverStream } from "../../src/message-target-over-stream.js";

const node = await createLibp2p({
  addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
});
await serve({ node, maxInboundStreams: 400 }, (input) =>
  (async function* () {
    yield new Uint8Array([1]);
    for await (const _ of input);
    await new Promise(() => {});
  })(),
);
await node.handle(
  "/test-mux/1.0.0",
  (stream) => {
    const { target, signal } = messageTargetOverStream(stream);
    multiplexPort(target, {
      codec: msgpackCodec,
      side: "responder",
      signal,
      onPort: (port) => {
        port.postMessage("hello");
        return true;
      },
    });
  },
  { maxInboundStreams: 4 },
);
process.send?.(node.getMultiaddrs()[0]?.toString());
