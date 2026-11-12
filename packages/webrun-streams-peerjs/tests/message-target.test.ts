import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_MESSAGE_SIZE,
  DRAIN_LOW_WATER,
  messageTargetOverPeerJs,
} from "../src/message-target.js";

/** The slice of a PeerJS `DataConnection` the adapter touches, in Node. */
class FakeConn {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  on(ev: string, fn: (...a: unknown[]) => void) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)?.add(fn);
  }
  off(ev: string, fn: (...a: unknown[]) => void) {
    this.handlers.get(ev)?.delete(fn);
  }
  emit(ev: string, ...a: unknown[]) {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...a);
  }
  serialization = "raw";
  open = true;
  bufferSize = 0;
  dataChannel = { bufferedAmount: 0 };
  sent: unknown[] = [];
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.open = false;
    this.emit("close");
  }
}
const make = (o?: Parameters<typeof messageTargetOverPeerJs>[1]) => {
  const conn = new FakeConn();
  // biome-ignore lint/suspicious/noExplicitAny: a structural fake
  return { conn, ...messageTargetOverPeerJs(conn as any, o) };
};

describe("messageTargetOverPeerJs", () => {
  it("requires serialization 'raw': BinaryPack would re-frame the bytes", () => {
    const conn = new FakeConn();
    conn.serialization = "binary";
    // biome-ignore lint/suspicious/noExplicitAny: a structural fake
    expect(() => messageTargetOverPeerJs(conn as any)).toThrow(TypeError);
  });

  it("delivers inbound bytes as Uint8Array copies, ArrayBuffer and views included", () => {
    const { conn, target } = make();
    const got: Uint8Array[] = [];
    target.addEventListener("message", (e) => {
      got.push(e.data as Uint8Array);
    });
    const shared = new Uint8Array([0, 1, 2, 3, 4]);
    conn.emit("data", shared.subarray(1, 3));
    conn.emit("data", new Uint8Array([7]).buffer);
    shared[1] = 99;
    expect(got.map((g) => [...g])).toEqual([[1, 2], [7]]);
    expect(got.every((g) => g instanceof Uint8Array)).toBe(true);
  });

  it("inbound data that is not bytes ends the pipe loudly: a dropped envelope would hang its call", () => {
    const { conn, signal } = make();
    conn.emit("data", "a string");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(TypeError);
    expect(conn.open).toBe(false);
  });

  it("sends bytes as one message each and refuses anything else", () => {
    const { conn, target } = make();
    target.postMessage(new Uint8Array([1, 2]));
    expect(conn.sent).toHaveLength(1);
    expect(() => target.postMessage({ x: 1 })).toThrow(TypeError);
  });

  it("reports a maxMessageSize 256 bytes under the 16 KiB cross-browser frame limit, overridable", () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(16 * 1024);
    expect(make().maxMessageSize).toBe(DEFAULT_MAX_MESSAGE_SIZE);
    expect(DEFAULT_MAX_MESSAGE_SIZE).toBe(16 * 1024 - 256);
    const big = make({ maxFrameBytes: 256 * 1024 });
    expect(big.maxMessageSize).toBe(256 * 1024 - 256);
    expect(make({ maxMessageSize: 4096 }).maxMessageSize).toBe(4096);
  });

  it("a frame past maxFrameBytes ends the pipe loudly instead of dying silently", () => {
    const { conn, target, signal } = make();
    expect(() => target.postMessage(new Uint8Array(DEFAULT_MAX_FRAME_BYTES + 1))).toThrow(
      RangeError,
    );
    expect(conn.sent).toHaveLength(0);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(RangeError);
    expect(conn.open).toBe(false);
    target.postMessage(new Uint8Array(DEFAULT_MAX_FRAME_BYTES)); // exactly the limit: allowed shape
  });

  it("aborts its signal when the connection closes or errors, then posting is a no-op", () => {
    const a = make();
    a.conn.close();
    expect(a.signal.aborted).toBe(true);
    a.target.postMessage(new Uint8Array([1]));
    expect(a.conn.sent).toHaveLength(0);
    const b = make();
    b.conn.emit("error", new Error("ice failed"));
    expect(b.signal.aborted).toBe(true);
    expect((b.signal.reason as Error).message).toMatch(/ice failed/);
  });

  it("close() closes the connection and aborts the signal", async () => {
    const { conn, target, signal } = make();
    await target.close();
    expect(conn.open).toBe(false);
    expect(signal.aborted).toBe(true);
  });

  it("bufferedAmount is the data channel's; whenDrained waits for PeerJS's queue and the low-water mark", async () => {
    const { conn, target } = make();
    conn.dataChannel.bufferedAmount = DRAIN_LOW_WATER;
    await target.whenDrained(); // at the mark, with nothing queued: it can take more
    conn.dataChannel.bufferedAmount = DRAIN_LOW_WATER + 5000;
    conn.bufferSize = 2;
    expect(target.bufferedAmount).toBe(DRAIN_LOW_WATER + 5000);
    let drained = false;
    const p = target.whenDrained().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(drained).toBe(false);
    conn.bufferSize = 0;
    await new Promise((r) => setTimeout(r, 30));
    expect(drained).toBe(false);
    conn.dataChannel.bufferedAmount = 1000;
    await p;
    expect(drained).toBe(true);
  });
});
