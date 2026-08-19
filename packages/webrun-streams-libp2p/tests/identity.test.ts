import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { describe, expect, it } from "vitest";
import { connect, serveConnections } from "../src/index.js";

async function node(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
}

describe("serveConnections", () => {
  it("hands the handler the peer id Noise proved for the connection", async () => {
    const server = await node(true);
    const client = await node(false);
    const seen: string[] = [];

    const stop = await serveConnections({ node: server }, (context) => {
      seen.push(context.remotePeer.toString());
      return async function* echo(input) {
        for await (const chunk of input) yield chunk;
      };
    });

    const addr = server.getMultiaddrs()[0];
    if (addr == null) throw new Error("server has no listen address");
    const { call, close } = await connect({ node: client, peer: addr });

    const out: Uint8Array[] = [];
    for await (const chunk of call(
      (async function* () {
        yield new TextEncoder().encode("ping");
      })(),
    )) {
      out.push(chunk);
    }

    await close();
    await stop();

    expect(new TextDecoder().decode(out[0])).toBe("ping");
    expect(seen).toEqual([client.peerId.toString()]);

    await Promise.allSettled([server.stop(), client.stop()]);
  });
});
