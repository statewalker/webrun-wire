import net from "node:net";
import type { Libp2p } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { deserialize, serialize } from "@statewalker/webrun-msgpack";
import { afterEach, describe, expect, it } from "vitest";
import { connect, portProtocolOf, serve } from "../src/connect-serve.js";
import { encodeVarint } from "../src/duplex-over-stream.js";
import {
  DEFAULT_PORT_MAX_MESSAGE_SIZE,
  libp2pPortMux,
  type StreamPort,
  windowProtocolOf,
} from "../src/port-mux.js";
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

// Review of #196: credit for the peer went out even while the stream needed to
// drain, and no stall timer watched it. A peer that uploads without regard for
// the window, to a port that keeps consuming, and never reads its own stream,
// made the server append a credit frame per consumed batch to yamux's
// unbounded write buffer, for ever. The attacker is a raw stream here: the
// honest stack would stop uploading once it ran out of credit.
describe("a peer that uploads and never reads (review of #196)", () => {
  it("credit is held back while the stream needs to drain, and the stall timeout resets the stream", async () => {
    const pair = await stalledPair();
    const protocol = "/stall-upload/1.0.0";
    const codec = { encode: serialize, decode: deserialize };
    let port: StreamPort | undefined;
    let consumed = 0;
    const mux = await libp2pPortMux({
      node: pair.server,
      codec,
      protocol,
      window: 64 * KiB, // credit goes back per 16 KiB consumed
      drainTimeoutMs: 2_000,
      onPort: (p) => {
        port = p;
        p.addEventListener("message", (event) => {
          consumed += (event.data as Uint8Array).byteLength;
        });
        return true;
      },
    });
    cleanups.push(() => mux.close());
    const stream = await pair.client.dialProtocol(pair.server.peerId, windowProtocolOf(protocol));
    cleanups.push(() => stream.abort(new Error("test over")));
    // The attacker never reads what the server sends: its yamux stops granting
    // the server window on this stream, while the connection stays live.
    stream.pause();
    const frame = (bytes: Uint8Array) => {
      const header = encodeVarint(bytes.byteLength);
      const out = new Uint8Array(header.byteLength + bytes.byteLength);
      out.set(header, 0);
      out.set(bytes, header.byteLength);
      return out;
    };
    const hello = new Uint8Array([0xc1, 0x01, 0, 0, 0, 0]);
    new DataView(hello.buffer).setUint32(2, 64 * KiB);
    const data = frame(codec.encode(new Uint8Array(16 * KiB).fill(1)));
    stream.send(frame(hello));
    const writeBuffer = () => {
      let bytes = 0;
      for (const c of pair.server.getConnections())
        for (const s of c.streams)
          if (s.protocol === windowProtocolOf(protocol)) bytes += s.writeBufferLength;
      return bytes;
    };
    // Enough to spend the attacker's yamux receive window (256 KiB) on credit
    // frames (7 bytes per 16 KiB consumed), and then some.
    let worst = 0;
    const started = Date.now();
    while (consumed < 1024 * MiB && !port?.closeSignal.aborted && Date.now() - started < 40_000) {
      if (stream.status !== "open") break;
      if (!stream.send(data)) {
        await Promise.race([
          new Promise((resolve) => stream.addEventListener("drain", resolve, { once: true })),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
      }
      worst = Math.max(worst, writeBuffer());
    }
    // The upload has stopped (or the server reset it): the stall timeout ends the port.
    const deadline = Date.now() + 10_000;
    while (!port?.closeSignal.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(consumed).toBeGreaterThan(300 * MiB);
    expect(worst).toBeLessThanOrEqual(1 * KiB);
    expect(port?.closeSignal.aborted).toBe(true);
    expect(String((port?.closeSignal.reason as Error | undefined)?.message)).toMatch(/drain/);
  }, 90_000);
});
