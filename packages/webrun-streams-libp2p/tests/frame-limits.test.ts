import type { Libp2p, Stream } from "@libp2p/interface";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROTOCOL, serve } from "../src/connect-serve.js";
import { encodeVarint, parseFrames } from "../src/duplex-over-stream.js";
import { legacyConnect, legacyServeConnections } from "../src/legacy-connect-serve.js";
import { createNode } from "./make-libp2p-pair.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function node(): Promise<Libp2p> {
  const n = await createNode();
  cleanups.push(() => n.stop());
  return n;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

// The deprecated protocol's framing (statewalker/webrun-wire#153): `serve`
// still answers it on `protocol` itself, for older callers, so the raw streams
// below reach the shim a new server runs.

/**
 * A server whose handler reads its whole input and records how that ended, and a raw stream to
 * it that sends `bytes` as they are, outside the framing's rules.
 */
async function rawCallTo(bytes: Uint8Array, maxFrameBytes?: number) {
  const serverNode = await node();
  const seen: { outcome: unknown } = { outcome: "pending" };
  const warn = console.warn;
  console.warn = () => {}; // serve logs the failed inbound stream
  cleanups.push(() => {
    console.warn = warn;
  });
  await serve({ node: serverNode, maxFrameBytes }, (input) =>
    (async function* () {
      try {
        for await (const _ of input) {
          /* read */
        }
        seen.outcome = "end";
      } catch (err) {
        seen.outcome = err;
      }
      yield* [];
    })(),
  );
  const addr = serverNode.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  const clientNode = await node();
  const stream: Stream = await clientNode.dialProtocol(addr, [DEFAULT_PROTOCOL]);
  let closed = false;
  stream.addEventListener("close", () => {
    closed = true;
  });
  stream.send(bytes);
  return { seen, isClosed: () => closed };
}

describe("duplexOverStream — frame limits", () => {
  it("a frame length past maxFrameBytes fails the call and aborts the stream", async () => {
    const { seen, isClosed } = await rawCallTo(new Uint8Array([0x00, 0x80, 0x80, 0x04]), 1024);
    expect(await waitFor(() => seen.outcome !== "pending" && isClosed(), 3000)).toBe(true);
    expect(seen.outcome).toBeInstanceOf(Error);
    expect((seen.outcome as Error).message).toContain("maxFrameBytes");
  });

  it("the default cap refuses a frame that declares about 4 GiB", async () => {
    const { seen, isClosed } = await rawCallTo(
      new Uint8Array([0x00, ...encodeVarint(0xffff_ffff), 1, 2, 3]),
    );
    expect(await waitFor(() => seen.outcome !== "pending" && isClosed(), 3000)).toBe(true);
    expect((seen.outcome as Error).message).toContain("maxFrameBytes");
  });

  it("a malformed length (a varint that never ends) fails the call and aborts the stream", async () => {
    const { seen, isClosed } = await rawCallTo(
      new Uint8Array([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    );
    expect(await waitFor(() => seen.outcome !== "pending" && isClosed(), 3000)).toBe(true);
    expect(seen.outcome).toBeInstanceOf(Error);
    expect((seen.outcome as Error).message).toContain("malformed");
  });

  it("one large producer chunk crosses as several bounded frames, intact", async () => {
    const serverNode = await node();
    const size = 4 * 1024 * 1024;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = (i * 7) & 0xff;
    await legacyServeConnections(
      { node: serverNode },
      () => (input) =>
        (async function* () {
          for await (const _ of input) {
            /* drain */
          }
          yield body;
        })(),
    );
    const addr = serverNode.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const { call, close } = await legacyConnect({ node: await node(), peer: addr });
    cleanups.push(close);
    const chunks: Uint8Array[] = [];
    for await (const c of call([new Uint8Array([1])])) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(64 * 1024);
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    expect(at).toBe(size);
    expect(all.every((b, i) => b === ((i * 7) & 0xff))).toBe(true);
  });

  it("reassembles one large frame from many small pieces in linear time", async () => {
    const payload = 16 * 1024 * 1024;
    const header = new Uint8Array([0x00, ...encodeVarint(payload)]);
    async function* pieces() {
      yield header;
      const piece = new Uint8Array(16 * 1024);
      for (let sent = 0; sent < payload; sent += piece.byteLength) yield piece;
    }
    const started = Date.now();
    const frames: number[] = [];
    for await (const f of parseFrames(pieces(), 64 * 1024 * 1024))
      frames.push(f.payload.byteLength);
    expect(frames).toEqual([payload]);
    // copying the whole buffer per piece (quadratic) took several seconds here
    expect(Date.now() - started).toBeLessThan(1500);
  }, 30_000);
});
