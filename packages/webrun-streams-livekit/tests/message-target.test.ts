import { describe, expect, it } from "vitest";
import {
  CLOSE_TOPIC,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_TOPIC,
  DRAIN_LOW_WATER,
  messageTargetOverLiveKit,
} from "../src/message-target.js";

type Handler = (...a: unknown[]) => void;
/** The slice of a LiveKit `Room` the adapter touches. */
class FakeRoom {
  private handlers = new Map<string, Set<Handler>>();
  published: Array<{
    data: Uint8Array;
    options: { topic?: string };
    settle: (err?: Error) => void;
  }> = [];
  remoteParticipants = new Map([["bob", { identity: "bob" }]]);
  goodbyes: unknown[] = [];
  localParticipant = {
    publishData: (data: Uint8Array, options: { topic?: string }) =>
      new Promise<void>((resolve, reject) => {
        if ((options as { topic?: string }).topic === CLOSE_TOPIC) {
          this.goodbyes.push(options);
          resolve();
          return;
        }
        this.published.push({ data, options, settle: (err) => (err ? reject(err) : resolve()) });
      }),
  };
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)?.add(fn);
  }
  off(ev: string, fn: Handler) {
    this.handlers.get(ev)?.delete(fn);
  }
  emit(ev: string, ...a: unknown[]) {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...a);
  }
  count(ev: string) {
    return this.handlers.get(ev)?.size ?? 0;
  }
}
const make = (o?: Parameters<typeof messageTargetOverLiveKit>[2]) => {
  const room = new FakeRoom();
  // biome-ignore lint/suspicious/noExplicitAny: a structural fake
  return { room, ...messageTargetOverLiveKit(room as any, "bob", o) };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("messageTargetOverLiveKit", () => {
  it("delivers only the named participant's packets, as Uint8Array copies", () => {
    const { room, target } = make();
    const got: Uint8Array[] = [];
    target.addEventListener("message", (e) => {
      got.push(e.data as Uint8Array);
    });
    const payload = new Uint8Array([1, 2]);
    room.emit("dataReceived", payload, { identity: "bob" }, 0, DEFAULT_TOPIC);
    room.emit("dataReceived", new Uint8Array([9]), { identity: "carol" }, 0, DEFAULT_TOPIC);
    room.emit("dataReceived", new Uint8Array([8]), undefined, 0, DEFAULT_TOPIC);
    room.emit("dataReceived", new Uint8Array([7]), { identity: "bob" }, 0, "chat");
    room.emit("dataReceived", new Uint8Array([6]), { identity: "bob" });
    payload[0] = 99; // LiveKit may reuse its buffer: what was delivered must not change
    expect(got.map((g) => [...g])).toEqual([[1, 2]]);
  });

  it("publishes reliably, to the named participant only, and refuses non-bytes", () => {
    const { room, target } = make();
    target.postMessage(new Uint8Array([5]));
    expect(room.published).toHaveLength(1);
    expect(room.published[0]?.options).toEqual({
      reliable: true,
      destinationIdentities: ["bob"],
      topic: DEFAULT_TOPIC,
    });
    expect(() => target.postMessage("x")).toThrow(TypeError);
  });

  it("reports 12 KiB by default under livekit-client's 64,000-byte packet cap, overridable", () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(64_000);
    expect(DEFAULT_MAX_MESSAGE_SIZE).toBe(12 * 1024);
    expect(make().maxMessageSize).toBe(12 * 1024);
    expect(make({ maxMessageSize: 4000 }).maxMessageSize).toBe(4000);
  });

  it("a frame past maxFrameBytes ends the pipe with RangeError instead of vanishing", () => {
    const { room, target, signal } = make();
    expect(() => target.postMessage(new Uint8Array(DEFAULT_MAX_FRAME_BYTES + 1))).toThrow(
      RangeError,
    );
    expect(room.published).toHaveLength(0);
    expect(signal.reason).toBeInstanceOf(RangeError);
  });

  it("(review) a packet of exactly maxFrameBytes is published; the guard starts one byte past it", () => {
    const { room, target, signal } = make();
    target.postMessage(new Uint8Array(DEFAULT_MAX_FRAME_BYTES));
    expect(room.published).toHaveLength(1);
    expect(signal.aborted).toBe(false);
  });

  it("(review) publishes a copy: livekit-client serializes after an await", () => {
    const { room, target } = make();
    const buf = new Uint8Array([1, 2, 3]);
    target.postMessage(buf);
    buf[0] = 9;
    expect([...(room.published[0]?.data ?? [])]).toEqual([1, 2, 3]);
  });

  it("(review) refuses a participant who is not in the room: packets to them vanish", () => {
    const room = new FakeRoom();
    // biome-ignore lint/suspicious/noExplicitAny: a structural fake
    expect(() => messageTargetOverLiveKit(room as any, "nobody")).toThrow(/not in the room/);
  });

  it("(review) ending locally tells the peer: a goodbye on CLOSE_TOPIC, which ends the peer's pipe", async () => {
    const a = make();
    await a.target.close();
    expect(a.room.goodbyes).toEqual([
      { reliable: true, destinationIdentities: ["bob"], topic: CLOSE_TOPIC },
    ]);
    const b = make();
    expect(() => b.target.postMessage(new Uint8Array(DEFAULT_MAX_FRAME_BYTES + 1))).toThrow(
      RangeError,
    );
    expect(b.room.goodbyes).toHaveLength(1);
    const c = make();
    c.room.emit("dataReceived", new Uint8Array(0), { identity: "carol" }, 0, CLOSE_TOPIC);
    expect(c.signal.aborted).toBe(false);
    c.room.emit("dataReceived", new Uint8Array(0), { identity: "bob" }, 0, CLOSE_TOPIC);
    expect(c.signal.aborted).toBe(true);
    expect(c.room.goodbyes).toHaveLength(0); // the peer already knows
  });

  it("aborts its signal when the room disconnects or the peer leaves; others leaving do not", () => {
    const a = make();
    a.room.emit("participantDisconnected", { identity: "carol" });
    expect(a.signal.aborted).toBe(false);
    a.room.emit("participantDisconnected", { identity: "bob" });
    expect(a.signal.aborted).toBe(true);
    const b = make();
    b.room.emit("disconnected");
    expect(b.signal.aborted).toBe(true);
    expect(b.room.count("dataReceived")).toBe(0);
  });

  it("a failed reliable publish ends the pipe: the stream above it lost a message", async () => {
    const { room, target, signal } = make();
    target.postMessage(new Uint8Array([1]));
    room.published[0]?.settle(new Error("data channel closed"));
    await tick();
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toMatch(/data channel closed/);
  });

  it("close() detaches from the room and aborts, without disconnecting the room", async () => {
    const { room, target, signal } = make();
    await target.close();
    expect(signal.aborted).toBe(true);
    expect(room.count("dataReceived")).toBe(0);
    target.postMessage(new Uint8Array([1]));
    expect(room.published).toHaveLength(0);
  });

  it("bufferedAmount counts bytes whose publish has not settled; whenDrained waits for the low-water mark", async () => {
    const { room, target } = make();
    const chunk = new Uint8Array(10 * 1024);
    const n = Math.ceil(DRAIN_LOW_WATER / chunk.byteLength) + 2;
    for (let i = 0; i < n; i++) target.postMessage(chunk);
    expect(target.bufferedAmount).toBe(n * chunk.byteLength);
    let drained = false;
    const p = target.whenDrained().then(() => {
      drained = true;
    });
    room.published[0]?.settle();
    await tick();
    expect(drained).toBe(false);
    for (const x of room.published.slice(1, 3)) x.settle();
    await p;
    expect(target.bufferedAmount).toBeLessThanOrEqual(DRAIN_LOW_WATER);
    for (const x of room.published.slice(3)) x.settle();
    await tick();
    expect(target.bufferedAmount).toBe(0);
    await target.whenDrained();
  });
});
