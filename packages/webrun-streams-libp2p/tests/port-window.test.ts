import type { Libp2p } from "@libp2p/interface";
import { deserialize, serialize } from "@statewalker/webrun-msgpack";
import { connect, overPorts, serve } from "@statewalker/webrun-rpc";
import type { ValueCodec } from "@statewalker/webrun-streams";
import {
  describeDuplexAdapter,
  describePortWindow,
  type MakePair,
} from "@statewalker/webrun-streams-conformance";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_PORT_PROTOCOL, libp2pPortMux, windowProtocolOf } from "../src/port-mux.js";
import { createNode } from "./make-libp2p-pair.js";

// Per-port windows on libp2p's native ports (statewalker/webrun-wire#153): a
// mux given `window` dials the windowed protocol first and falls back to the
// plain one, so the protocol id settles at open whether both ends speak it.

const PROTOCOL = "/webrun-ports/window-test/1.0.0";

describePortWindow("libp2pPortMux", async (codec, windows) => {
  const server = await createNode();
  const client = await createNode();
  const addr = server.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  const opener = await libp2pPortMux({
    node: client,
    codec,
    peer: addr,
    protocol: PROTOCOL,
    window: windows.opener,
  });
  let serving: Awaited<ReturnType<typeof libp2pPortMux>> | undefined;
  return {
    opener,
    async serve(onPort) {
      serving = await libp2pPortMux({
        node: server,
        codec,
        protocol: PROTOCOL,
        onPort,
        window: windows.server,
      });
      return serving;
    },
    async dispose() {
      await serving?.close();
      await Promise.allSettled([client.stop(), server.stop()]);
    },
  };
});

describe("libp2pPortMux: the windowed protocol id", () => {
  it("is the plain protocol with /window appended", () => {
    expect(windowProtocolOf(DEFAULT_PORT_PROTOCOL)).toBe("/webrun-ports/1.0.0/window");
  });

  it("rejects a window that is not a positive integer", async () => {
    const node = { handle: async () => {}, unhandle: async () => {} } as unknown as Libp2p;
    await expect(
      libp2pPortMux({ node, codec: { encode: serialize, decode: deserialize }, window: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

const codec: ValueCodec = { encode: serialize, decode: deserialize };
const WINDOW = 1024 * 1024;
const nodes: Libp2p[] = [];
afterAll(async () => {
  await Promise.allSettled(nodes.splice(0).map((n) => n.stop()));
});

/**
 * The port stack over windowed native ports: chunks are pipelined, up to the
 * window in flight, and L6 holds a producer to the window (plus the chunk
 * queued in its port and the one in the consumer's hands).
 */
const makeWindowedPair: MakePair = async (tuning) => {
  const server = await createNode();
  const client = await createNode();
  nodes.push(server, client);
  const addr = server.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  const maxMessageSize = tuning?.maxMessageSize ?? 256 * 1024;
  return {
    runAheadBytes: WINDOW + 2 * maxMessageSize,
    async connect() {
      return connect({
        mux: overPorts(() =>
          libp2pPortMux({
            node: client,
            codec,
            peer: addr,
            protocol: PROTOCOL,
            maxMessageSize,
            window: WINDOW,
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
              codec,
              protocol: PROTOCOL,
              onPort,
              maxMessageSize,
              window: WINDOW,
            }),
          ),
        },
        handler,
      );
    },
    async close() {
      await Promise.allSettled([client.stop(), server.stop()]);
    },
  };
};

describeDuplexAdapter("webrun-streams-libp2p, native ports with a window", makeWindowedPair);
