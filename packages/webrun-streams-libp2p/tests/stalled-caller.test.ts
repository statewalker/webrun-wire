import net from "node:net";
import type { Libp2p } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { afterEach, describe, expect, it } from "vitest";
import { connect, portProtocolOf, serve } from "../src/connect-serve.js";
import { DEFAULT_PORT_MAX_MESSAGE_SIZE } from "../src/port-mux.js";
import { DEFAULT_PROTOCOL } from "../src/shared.js";
import { createNode } from "./make-libp2p-pair.js";

// A caller that announces a huge window, reads the response head, then stops
// reading at the transport (statewalker/webrun-wire#195). Before the fix the
// server trusted the caller's window (up to 4 GiB − 1), ignored libp2p's
// `send()` returning `false`, and had no stall bound on the port path, so it
// buffered the whole response in the stream's write buffer and held it for
// ever (1 GiB held past 40 s in the httpeers reproduction).
//
// The caller's transport is paused with a TCP proxy between the nodes, as in
// that reproduction: two nodes connected directly keep reading eagerly into
// their own buffers, so the server would never see backpressure.

const KiB = 1024;
const MiB = 1024 * KiB;
const CHUNK = 256 * KiB;
/** The most the handler produces: enough to show an unbounded buffer, short of exhausting memory. */
const LIMIT = 192 * MiB;
const STALL_MS = 2_500;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A server node, a client node dialled to it through a TCP proxy whose server side can be paused. */
async function stalledPair() {
  const server = await createNode();
  const client = await createNode();
  const upstreams: net.Socket[] = [];
  const downstreams: net.Socket[] = [];
  const serverPort = Number(server.getMultiaddrs()[0]?.toString().split("/")[4]);
  const proxy = net.createServer((down) => {
    const up = net.connect(serverPort, "127.0.0.1");
    upstreams.push(up);
    downstreams.push(down);
    down.pipe(up);
    up.pipe(down);
    const destroy = () => {
      up.destroy();
      down.destroy();
    };
    up.on("error", destroy);
    down.on("error", destroy);
    up.on("close", destroy);
    down.on("close", destroy);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address() as net.AddressInfo;
  await client.dial(multiaddr(`/ip4/127.0.0.1/tcp/${address.port}/p2p/${server.peerId}`));
  cleanups.push(async () => {
    for (const s of [...upstreams, ...downstreams]) s.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await Promise.allSettled([client.stop(), server.stop()]);
  });
  return {
    server,
    client,
    /** The caller stops reading: the proxy stops taking the server's bytes. */
    pause() {
      for (const up of upstreams) up.pause();
    },
  };
}

/** What the server's port streams hold in their write buffers, in bytes. */
function serverWriteBuffer(server: Libp2p): number {
  const ports = portProtocolOf(DEFAULT_PROTOCOL);
  let bytes = 0;
  for (const connection of server.getConnections())
    for (const stream of connection.streams)
      if (stream.protocol?.startsWith(ports)) bytes += stream.writeBufferLength ?? 0;
  return bytes;
}

/** A handler that streams a large response, and says when it was released. */
function bigResponse() {
  const state = { produced: 0, released: false, releasedAt: 0 };
  const chunk = new Uint8Array(CHUNK).fill(7);
  const handler = async function* () {
    try {
      while (state.produced < LIMIT) {
        state.produced += chunk.byteLength;
        yield chunk;
      }
    } finally {
      state.released = true;
      state.releasedAt = Date.now();
    }
  };
  return { state, handler };
}

async function runStalled(window: number | undefined) {
  const pair = await stalledPair();
  const { state, handler } = bigResponse();
  const stop = await serve({ node: pair.server, drainTimeoutMs: STALL_MS }, handler);
  cleanups.push(stop);
  const conn = await connect({ node: pair.client, peer: pair.server.peerId, window });
  cleanups.push(() => conn.close());
  const it = conn.call([])[Symbol.asyncIterator]();
  cleanups.push(() => void it.return?.(undefined).catch(() => undefined));
  const head = await it.next(); // the response head
  expect(head.done).toBe(false);
  pair.pause();
  const pausedAt = Date.now();
  // Watched for most of the stall timeout: the write buffer must stay bounded.
  let worst = 0;
  while (Date.now() - pausedAt < STALL_MS - 500) {
    worst = Math.max(worst, serverWriteBuffer(pair.server));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Then the server gives up on the stalled call: the stream is reset and the handler released.
  const deadline = Date.now() + STALL_MS + 5_000;
  while (!state.released && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { worst, state, pausedAt, server: pair.server };
}

describe("a caller that stalls its transport (statewalker/webrun-wire#195)", () => {
  it("announcing a 4 GiB window: the server holds at most one window and a frame, then resets the stream", async () => {
    const { worst, state, pausedAt, server } = await runStalled(0xffffffff);
    // One local window (the server's default, 4 MiB) plus one frame, at the very most;
    // with the transport's backpressure honoured, about one frame.
    expect(worst).toBeLessThanOrEqual(4 * MiB + DEFAULT_PORT_MAX_MESSAGE_SIZE + 64 * KiB);
    expect(state.produced).toBeLessThan(16 * MiB);
    expect(state.released).toBe(true);
    expect(state.releasedAt - pausedAt).toBeGreaterThanOrEqual(STALL_MS - 500);
    expect(serverWriteBuffer(server)).toBe(0);
  }, 30_000);

  it("an honest caller with the default window: the server holds about one frame, then resets the stream", async () => {
    const { worst, state } = await runStalled(undefined);
    // Nothing is written past the transport's buffer beyond one frame.
    expect(worst).toBeLessThanOrEqual(DEFAULT_PORT_MAX_MESSAGE_SIZE + 64 * KiB);
    expect(state.released).toBe(true);
  }, 30_000);
});
