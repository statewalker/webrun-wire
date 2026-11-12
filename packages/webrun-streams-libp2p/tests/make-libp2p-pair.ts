import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import type { ConnectServePair, MakePair } from "@statewalker/webrun-streams-conformance";
import { createLibp2p } from "libp2p";
import { connect, serve } from "../src/connect-serve.js";

/** The receive window this pair's nodes grant per stream (yamux's default is 16 MiB). */
export const PAIR_STREAM_WINDOW = 1024 * 1024;
export const YAMUX_DEFAULT_WINDOW = 16 * 1024 * 1024;

/** A TCP node; `maxStreamWindowSize` null keeps yamux's default window. */
export async function createNode(
  maxStreamWindowSize: number | null = PAIR_STREAM_WINDOW,
): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [
      yamux(maxStreamWindowSize === null ? {} : { streamOptions: { maxStreamWindowSize } }),
    ],
  });
}

/**
 * Run-ahead past a consumer that stopped reading (L6, spec D17): the window
 * the receiving node granted before its stream paused, plus what is queued on
 * the receiving side — the paced reader's high-water mark and, on the serving
 * side, the handler's input queue (64 KiB each) — plus a frame in flight.
 * Measured: 1.06 MiB for a 1 MiB window, 16.05-16.12 MiB for yamux's default.
 */
export const runAheadFor = (window: number): number => window + 3 * 64 * 1024;

/**
 * Two TCP nodes granting {@link PAIR_STREAM_WINDOW} per stream, so a stalled
 * consumer bounds its producer at about 1.2 MiB (`runAheadFor`).
 */
export const makeLibp2pPair: MakePair = async () => makePairWith(PAIR_STREAM_WINDOW);

/** The same with another window (`null`: yamux's default, 16 MiB). */
export async function makePairWith(window: number | null): Promise<ConnectServePair> {
  const serverNode = await createNode(window);
  const clientNode = await createNode(window);

  const serverAddr = serverNode.getMultiaddrs()[0];
  if (!serverAddr) {
    await Promise.all([serverNode.stop(), clientNode.stop()]);
    throw new Error("webrun-streams-libp2p: server node has no listen address");
  }

  return {
    runAheadBytes: runAheadFor(window ?? YAMUX_DEFAULT_WINDOW),
    async connect() {
      return connect({ node: clientNode, peer: serverAddr });
    },
    async serve(handler) {
      return serve({ node: serverNode }, handler);
    },
    async close() {
      await Promise.allSettled([serverNode.stop(), clientNode.stop()]);
    },
  };
}
