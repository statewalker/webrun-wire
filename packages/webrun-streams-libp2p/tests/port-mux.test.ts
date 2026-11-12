import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, overPorts, serve } from "@statewalker/webrun-rpc";
import { collectBytes } from "@statewalker/webrun-streams";
import { describeDuplexAdapter, type MakePair } from "@statewalker/webrun-streams-conformance";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { messageTargetOverStream } from "../src/message-target-over-stream.js";
import { libp2pPortMux } from "../src/port-mux.js";

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
const PROTOCOL = "/webrun-ports/test/1.0.0";

/**
 * The port stack over libp2p with NATIVE ports: every port is its own libp2p
 * stream (yamux multiplexes them), so `overPorts` hands each call a stream.
 * L6: the port stack's confirmation keeps a producer within one chunk of a
 * stalled consumer, whatever libp2p buffers below it.
 */
const makeNativePortPair: MakePair = async (tuning) => {
  const server = await createNode();
  const client = await createNode();
  const addr = server.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  return {
    runAheadBytes: 4096,
    async connect() {
      return connect({
        mux: overPorts(() =>
          libp2pPortMux({
            node: client,
            peer: addr,
            protocol: PROTOCOL,
            maxMessageSize: tuning?.maxMessageSize,
          }),
        ),
      });
    },
    async serve(handler) {
      return serve(
        {
          mux: overPorts((onPort) =>
            libp2pPortMux({
              node: server,
              protocol: PROTOCOL,
              onPort,
              maxMessageSize: tuning?.maxMessageSize,
            }),
          ),
        },
        handler,
      );
    },
    async close() {
      await Promise.allSettled([server.stop(), client.stop()]);
    },
  };
};

/** The port stack over ONE libp2p stream: `multiplexPort` invents the ports (emulated). */
const makeEmulatedPortPair: MakePair = async (tuning) => {
  const server = await createNode();
  const client = await createNode();
  const addr = server.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  const served = new Set<() => Promise<void>>();
  return {
    runAheadBytes: 4096,
    async connect() {
      const stream = await client.dialProtocol(addr, PROTOCOL);
      const { target, signal } = messageTargetOverStream(stream);
      return connect({
        mux: overPipe(target, {
          codec: msgpackCodec,
          side: "initiator",
          signal,
          maxMessageSize: tuning?.maxMessageSize,
        }),
      });
    },
    async serve(handler) {
      await server.handle(PROTOCOL, (stream) => {
        const { target, signal } = messageTargetOverStream(stream);
        void serve(
          {
            mux: overPipe(target, {
              codec: msgpackCodec,
              side: "responder",
              signal,
              maxMessageSize: tuning?.maxMessageSize,
            }),
          },
          handler,
        ).then((stop) => served.add(stop));
      });
      return async () => {
        await server.unhandle(PROTOCOL);
        for (const stop of served) await stop();
      };
    },
    async close() {
      await Promise.allSettled([server.stop(), client.stop()]);
    },
  };
};

describeDuplexAdapter("libp2p, native ports (a stream per port)", makeNativePortPair, {
  skipHugeBody: true,
});
describeDuplexAdapter(
  "libp2p, emulated ports (multiplexPort over one stream)",
  makeEmulatedPortPair,
  {
    skipHugeBody: true,
  },
);

describe("libp2pPortMux", () => {
  it("each port is its own stream; a port's close signal aborts when the peer goes", async () => {
    const server = await createNode();
    const client = await createNode();
    const addr = server.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const accepted: unknown[] = [];
    await libp2pPortMux({
      node: server,
      protocol: PROTOCOL,
      onPort: (_port, meta) => {
        accepted.push(meta);
        return true;
      },
    });
    const mux = await libp2pPortMux({ node: client, peer: addr, protocol: PROTOCOL });
    const p1 = await mux.openPort();
    const p2 = await mux.openPort();
    await expect.poll(() => accepted.length).toBe(2);
    // the serving side learns which peer libp2p proved on the connection
    expect((accepted[0] as { remotePeer: { toString(): string } }).remotePeer.toString()).toBe(
      client.peerId.toString(),
    );
    const streams = client
      .getConnections()
      .flatMap((c) => c.streams.filter((s) => s.protocol === PROTOCOL));
    expect(streams.length).toBe(2);
    const signal = (p1 as { closeSignal?: AbortSignal }).closeSignal;
    expect(signal?.aborted).toBe(false);
    await server.stop();
    await expect.poll(() => signal?.aborted, { timeout: 5000 }).toBe(true);
    expect((p2 as { closeSignal?: AbortSignal }).closeSignal?.aborted).toBe(true);
  });

  it("a call in flight over native ports fails when the serving node dies, instead of hanging", async () => {
    const server = await createNode();
    const client = await createNode();
    const addr = server.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    await serve(
      { mux: overPorts((onPort) => libp2pPortMux({ node: server, protocol: PROTOCOL, onPort })) },
      async function* (input) {
        for await (const _ of input);
        yield new Uint8Array([1]);
        await new Promise(() => {});
      },
    );
    const { call, close } = await connect({
      mux: overPorts(() => libp2pPortMux({ node: client, peer: addr, protocol: PROTOCOL })),
    });
    const it = call([])[Symbol.asyncIterator]();
    await it.next();
    const rest = it.next();
    await server.stop();
    await expect(rest).rejects.toBeDefined();
    await close();
  });

  it("close() stops accepting and closes the ports it opened", async () => {
    const server = await createNode();
    const client = await createNode();
    const addr = server.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const serving = await libp2pPortMux({ node: server, protocol: PROTOCOL, onPort: () => true });
    const mux = await libp2pPortMux({ node: client, peer: addr, protocol: PROTOCOL });
    const p = await mux.openPort();
    await mux.close();
    expect((p as { closeSignal?: AbortSignal }).closeSignal?.aborted).toBe(true);
    await serving.close();
    await expect(
      (await libp2pPortMux({ node: client, peer: addr, protocol: PROTOCOL })).openPort(),
    ).rejects.toThrow();
  });
});

describe("throughput: a 4 MiB body (measurement)", () => {
  it("native and emulated ports, at 64 KiB and 256 KiB chunks", async () => {
    const body = new Uint8Array(4 * 1024 * 1024);
    for (const [label, make] of [
      ["native", makeNativePortPair],
      ["emulated", makeEmulatedPortPair],
    ] as const) {
      for (const maxMessageSize of [64 * 1024, 256 * 1024]) {
        const pair = await make({ maxMessageSize });
        await pair.serve(async function* (input) {
          for await (const chunk of input) yield chunk;
        });
        const { call, close } = await pair.connect();
        const t0 = performance.now();
        const back = await collectBytes(call([body]));
        const ms = performance.now() - t0;
        expect(back.byteLength).toBe(body.byteLength);
        console.log(
          `${label} ${maxMessageSize / 1024} KiB chunks: ${(8 / (ms / 1000)).toFixed(1)} MB/s echo`,
        );
        await close();
        await pair.close();
      }
    }
  }, 120_000);
});
