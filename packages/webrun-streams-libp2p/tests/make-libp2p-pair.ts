import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import type { ConnectServePair, MakePair } from "@statewalker/webrun-streams-conformance";
import { createLibp2p } from "libp2p";
import { connect, DEFAULT_WINDOW, serve } from "../src/connect-serve.js";
import { legacyConnect, legacyServeConnections } from "../src/legacy-connect-serve.js";
import { DEFAULT_PORT_MAX_MESSAGE_SIZE } from "../src/port-mux.js";

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
 * Run-ahead of `connect`/`serve` past a consumer that stopped reading (L6,
 * spec D17): the port window the consuming end grants, plus the chunk queued
 * in the producer's port and the one in the consumer's hands
 * (statewalker/webrun-wire#153). The yamux window under it does not count: the
 * port's credit bounds what is in flight, whatever libp2p buffers.
 */
export const portRunAheadFor = (window: number): number =>
  window + 2 * DEFAULT_PORT_MAX_MESSAGE_SIZE;

/**
 * Run-ahead of the deprecated protocol (`legacyConnect`/`legacyServeConnections`):
 * two yamux windows — a resume hands over what libp2p held while paused (up to
 * the window the receiving node granted) and grants a new one — plus what is
 * queued on the receiving side (the paced reader's high-water mark, the serving
 * side's input queue, a frame being parsed). Measured: 1.06 MiB for a 1 MiB
 * window when the consumer stalls at once, 2.00 MiB when it reads and stalls
 * by turns.
 */
export const runAheadFor = (window: number): number => 2 * window + 256 * 1024;

/**
 * Two TCP nodes running `connect`/`serve` (over the windowed native port mux),
 * with the default port window: a stalled consumer bounds its producer at
 * about 4.5 MiB (`portRunAheadFor`).
 */
export const makeLibp2pPair: MakePair = async () => makePortPairWith({});

/** The same with a port window other than the default. */
export async function makePortPairWith(options: {
  window?: number;
  streamWindow?: number | null;
}): Promise<ConnectServePair> {
  const nodes = await nodePair(
    options.streamWindow === undefined ? PAIR_STREAM_WINDOW : options.streamWindow,
  );
  const { window } = options;
  return {
    runAheadBytes: portRunAheadFor(window ?? DEFAULT_WINDOW),
    async connect() {
      return connect({ node: nodes.client, peer: nodes.addr, window });
    },
    async serve(handler) {
      return serve({ node: nodes.server, window }, handler);
    },
    close: nodes.close,
  };
}

/** Two TCP nodes running the deprecated protocol on both ends (yamux window 1 MiB). */
export const makeLegacyPair: MakePair = async () => makeLegacyPairWith(PAIR_STREAM_WINDOW);

/** The same with another yamux window (`null`: yamux's default, 16 MiB). */
export async function makeLegacyPairWith(window: number | null): Promise<ConnectServePair> {
  const nodes = await nodePair(window);
  return {
    runAheadBytes: runAheadFor(window ?? YAMUX_DEFAULT_WINDOW),
    async connect() {
      return legacyConnect({ node: nodes.client, peer: nodes.addr });
    },
    async serve(handler) {
      return legacyServeConnections({ node: nodes.server }, () => handler);
    },
    close: nodes.close,
  };
}

export async function nodePair(window: number | null = PAIR_STREAM_WINDOW) {
  const server = await createNode(window);
  const client = await createNode(window);
  const addr = server.getMultiaddrs()[0];
  if (!addr) {
    await Promise.all([server.stop(), client.stop()]);
    throw new Error("webrun-streams-libp2p: server node has no listen address");
  }
  return {
    server,
    client,
    addr,
    async close() {
      await Promise.allSettled([server.stop(), client.stop()]);
    },
  };
}
