import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import { collectBytes } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import {
  byteChannelFromRoom,
  DEFAULT_ROOM_MAX_FRAME_BYTES,
  DEFAULT_ROOM_TOPIC,
  DRAIN_LOW_WATER,
} from "../src/byte-channel.js";
import { DEFAULT_MAX_MESSAGE_SIZE, messageTargetOverByteChannel } from "../src/message-target.js";
import type { ByteChannel } from "../src/types.js";
import { MockRoom, RoomBus } from "./mocks/room-bus.js";

/** Two in-memory ByteChannels wired to each other, delivering on a later task. */
function channelPair(maxBytes = Number.POSITIVE_INFINITY): [ByteChannel, ByteChannel] {
  const make = () => {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    return {
      push(b: Uint8Array) {
        queue.push(b);
        wake?.();
      },
      end() {
        done = true;
        wake?.();
        resolveClosed();
      },
      recv: (async function* () {
        for (;;) {
          while (queue.length) yield queue.shift() as Uint8Array;
          if (done) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      })(),
      closed,
    };
  };
  const ia = make();
  const ib = make();
  const channel = (self: typeof ia, peer: typeof ia): ByteChannel => ({
    send: (bytes) => {
      // A transport with a ceiling drops what exceeds it: the test sees the stall.
      if (bytes.byteLength > maxBytes) return;
      const copy = bytes.slice();
      setTimeout(() => peer.push(copy), 0);
    },
    recv: self.recv,
    closed: self.closed,
    close: () => {
      self.end();
      peer.end();
    },
  });
  return [channel(ia, ib), channel(ib, ia)];
}

describe("messageTargetOverByteChannel", () => {
  it("carries the port stack: a call round-trips a body many times maxMessageSize", async () => {
    // frames past maxMessageSize + framing are dropped, so an ignored ceiling hangs this
    const [ca, cb] = channelPair(16 * 1024);
    const b = messageTargetOverByteChannel(cb);
    await serve(
      {
        mux: overPipe(b.target, {
          codec: msgpackCodec,
          side: "responder",
          signal: b.signal,
          maxMessageSize: b.maxMessageSize,
        }),
      },
      async function* echo(input) {
        for await (const chunk of input) yield chunk;
      },
    );
    const a = messageTargetOverByteChannel(ca);
    const { call, close } = await connect({
      mux: overPipe(a.target, {
        codec: msgpackCodec,
        side: "initiator",
        signal: a.signal,
        maxMessageSize: a.maxMessageSize,
      }),
    });
    const body = new Uint8Array(200_000).map((_, i) => i & 0xff);
    const back = await collectBytes(call([body]));
    expect(back).toEqual(body);
    await close();
  });

  it("reports a data channel's safe payload ceiling, overridable", () => {
    const [ca] = channelPair();
    expect(DEFAULT_MAX_MESSAGE_SIZE).toBe(16 * 1024 - 256);
    expect(messageTargetOverByteChannel(ca).maxMessageSize).toBe(DEFAULT_MAX_MESSAGE_SIZE);
    expect(messageTargetOverByteChannel(ca, { maxMessageSize: 1000 }).maxMessageSize).toBe(1000);
  });

  it("aborts its signal when the channel closes; posting after is a no-op; non-bytes are refused", async () => {
    const [ca, cb] = channelPair();
    const a = messageTargetOverByteChannel(ca);
    expect(() => a.target.postMessage({ x: 1 })).toThrow(TypeError);
    cb.close();
    await new Promise<void>((r) =>
      a.signal.aborted ? r() : a.signal.addEventListener("abort", () => r(), { once: true }),
    );
    let sent = 0;
    const send = ca.send;
    ca.send = (b) => {
      sent++;
      send(b);
    };
    a.target.postMessage(new Uint8Array([1]));
    expect(sent).toBe(0);
  });

  it("close() closes the channel and aborts the signal", async () => {
    const [ca, cb] = channelPair();
    const a = messageTargetOverByteChannel(ca);
    const b = messageTargetOverByteChannel(cb);
    await a.target.close();
    expect(a.signal.aborted).toBe(true);
    await new Promise<void>((r) =>
      b.signal.aborted ? r() : b.signal.addEventListener("abort", () => r(), { once: true }),
    );
  });
});

describe("(review) byteChannelFromRoom ends, so the port stack over it does not hang", () => {
  async function roomPair() {
    const bus = new RoomBus();
    const alice = new MockRoom("alice", bus);
    const bob = new MockRoom("bob", bus);
    await alice.connect();
    await bob.connect();
    return {
      alice,
      bob,
      a: byteChannelFromRoom(alice, "bob"),
      b: byteChannelFromRoom(bob, "alice"),
    };
  }
  const settled = (p: Promise<void>) =>
    Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);

  it("closes when the peer leaves the room", async () => {
    const { bob, a } = await roomPair();
    await bob.disconnect();
    expect(await settled(a.closed)).toBe(true);
  });

  it("closes when its own room disconnects", async () => {
    const { alice, a } = await roomPair();
    await alice.disconnect();
    expect(await settled(a.closed)).toBe(true);
  });

  it("closes when a reliable publish fails: the stream above lost a message", async () => {
    const { alice, a } = await roomPair();
    alice.localParticipant.publishData = () => Promise.reject(new Error("engine closed"));
    a.send(new Uint8Array([1]));
    expect(await settled(a.closed)).toBe(true);
  });

  it("ignores packets with no participant", async () => {
    const { alice, a } = await roomPair();
    const it = a.recv[Symbol.asyncIterator]();
    alice.emit("dataReceived", new Uint8Array([9]), undefined, undefined, DEFAULT_ROOM_TOPIC);
    alice.emit(
      "dataReceived",
      new Uint8Array([7]),
      { identity: "bob" },
      undefined,
      DEFAULT_ROOM_TOPIC,
    );
    expect([...((await it.next()).value as Uint8Array)]).toEqual([7]);
  });

  it("(#146) takes only its own topic, sent with the livekit adapter's default", async () => {
    const { alice, a } = await roomPair();
    expect(DEFAULT_ROOM_TOPIC).toBe("webrun/port-stack");
    const it = a.recv[Symbol.asyncIterator]();
    alice.emit("dataReceived", new Uint8Array([1]), { identity: "bob" }, undefined, "other-pipe");
    alice.emit("dataReceived", new Uint8Array([2]), { identity: "bob" });
    alice.emit(
      "dataReceived",
      new Uint8Array([3]),
      { identity: "bob" },
      undefined,
      DEFAULT_ROOM_TOPIC,
    );
    expect([...((await it.next()).value as Uint8Array)]).toEqual([3]);
  });

  it("(#146) two pipes on different topics to the same participant stay apart", async () => {
    const { alice, bob } = await roomPair();
    const a1 = byteChannelFromRoom(alice, "bob", { topic: "one" });
    const a2 = byteChannelFromRoom(alice, "bob", { topic: "two" });
    const b1 = byteChannelFromRoom(bob, "alice", { topic: "one" });
    const b2 = byteChannelFromRoom(bob, "alice", { topic: "two" });
    a1.send(new Uint8Array([1]));
    a2.send(new Uint8Array([2]));
    expect([...((await b1.recv[Symbol.asyncIterator]().next()).value as Uint8Array)]).toEqual([1]);
    expect([...((await b2.recv[Symbol.asyncIterator]().next()).value as Uint8Array)]).toEqual([2]);
  });

  it("(#146) closing one end says goodbye: the peer's channel ends while the room stays", async () => {
    const { a, b } = await roomPair();
    a.close();
    expect(await settled(b.closed)).toBe(true);
  });

  it("(#146) an oversized send throws RangeError and ends both ends", async () => {
    const { a, b } = await roomPair();
    expect(DEFAULT_ROOM_MAX_FRAME_BYTES).toBe(64_000);
    expect(() => a.send(new Uint8Array(DEFAULT_ROOM_MAX_FRAME_BYTES + 1))).toThrow(RangeError);
    expect(await settled(a.closed)).toBe(true);
    expect(await settled(b.closed)).toBe(true);
    const small = await roomPair();
    const c = byteChannelFromRoom(small.alice, "bob", { maxFrameBytes: 10 });
    expect(() => c.send(new Uint8Array(11))).toThrow(RangeError);
  });

  it("(#146) bufferedAmount counts unsettled publishes; whenDrained waits for them", async () => {
    const { alice, a } = await roomPair();
    const pending: Array<() => void> = [];
    alice.localParticipant.publishData = () =>
      new Promise<void>((r) => {
        pending.push(r);
      });
    const packet = 60_000;
    const count = Math.ceil(DRAIN_LOW_WATER / packet) + 1;
    for (let i = 0; i < count; i++) a.send(new Uint8Array(packet));
    expect(a.bufferedAmount).toBe(count * packet);
    const drained = a.whenDrained?.() ?? Promise.reject();
    expect(await settled(drained)).toBe(false);
    pending[0]();
    pending[1]();
    expect(await settled(drained)).toBe(true);
    for (const release of pending.slice(2)) release();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.bufferedAmount).toBe(0);
  });

  it("a call in flight over the port stack fails when the peer leaves", async () => {
    const { bob, a, b } = await roomPair();
    const pb = messageTargetOverByteChannel(b, { maxMessageSize: 12 * 1024 });
    await serve(
      { mux: overPipe(pb.target, { codec: msgpackCodec, side: "responder", signal: pb.signal }) },
      async function* (input) {
        for await (const _ of input);
        yield new Uint8Array([1]);
        await new Promise(() => {});
      },
    );
    const pa = messageTargetOverByteChannel(a, { maxMessageSize: 12 * 1024 });
    const { call, close } = await connect({
      mux: overPipe(pa.target, { codec: msgpackCodec, side: "initiator", signal: pa.signal }),
    });
    const it = call([])[Symbol.asyncIterator]();
    await it.next();
    const rest = it.next();
    await bob.disconnect();
    await expect(rest).rejects.toBeDefined();
    await close();
  });
});
