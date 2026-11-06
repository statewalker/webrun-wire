import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { afterEach, expect, it } from "vitest";
import { duplexOverStream } from "../src/duplex-over-stream.js";

const nodes: Libp2p[] = [];
afterEach(async () => {
  await Promise.allSettled(nodes.splice(0).map((n) => n.stop()));
});

async function createNode(): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
  nodes.push(node);
  return node;
}

// The peer answers and closes its write half before this side starts pulling:
// the `remoteCloseWrite` event has already fired when duplexOverStream attaches
// its listener, so it must read the stream's state instead of waiting for it.
it("a peer that closed its write half before the first pull ends the call cleanly", async () => {
  const server = await createNode();
  await server.handle("/late-pull/1.0.0", async (stream) => {
    stream.send(new Uint8Array([0x00, 1, 42]));
    await stream.close();
  });
  const client = await createNode();
  const addr = server.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  const stream = await client.dialProtocol(addr, ["/late-pull/1.0.0"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(stream.remoteWriteStatus).toBe("closed");
  const received: number[] = [];
  for await (const chunk of duplexOverStream(stream, [])) received.push(...chunk);
  expect(received).toEqual([42]);
});
