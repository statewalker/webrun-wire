import { describe, expect, it } from "vitest";
import { byteChannelFromDataChannel, DRAIN_LOW_WATER } from "../src/byte-channel.js";
import { messageTargetOverByteChannel } from "../src/message-target.js";
import type { ByteChannel } from "../src/types.js";

/** Just enough of an `RTCDataChannel` to drive the adapter. */
class FakeDataChannel extends EventTarget {
  binaryType = "blob";
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  failSend = false;
  send(data: unknown): void {
    if (this.failSend) throw new DOMException("send queue is full", "OperationError");
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  /** The browser's send queue drains below the threshold. */
  drain(): void {
    this.bufferedAmount = 0;
    this.dispatchEvent(new Event("bufferedamountlow"));
  }
}

const wrap = () => {
  const dc = new FakeDataChannel();
  return { dc, ch: byteChannelFromDataChannel(dc as unknown as RTCDataChannel) };
};
const settled = (p: Promise<unknown>) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);

describe("(#146) byteChannelFromDataChannel", () => {
  it("ends the channel on a non-byte message instead of throwing in the listener", async () => {
    const { dc, ch } = wrap();
    dc.receive(new Uint8Array([1]).buffer);
    dc.receive("text");
    expect(await settled(ch.closed)).toBe(true);
    expect(dc.readyState).toBe("closed");
    const got: number[][] = [];
    for await (const bytes of ch.recv) got.push([...bytes]);
    expect(got).toEqual([[1]]);
  });

  it("ends the channel when a send fails: the stream above lost a message", async () => {
    const { dc, ch } = wrap();
    dc.failSend = true;
    ch.send(new Uint8Array([1]));
    expect(await settled(ch.closed)).toBe(true);
  });

  it("reports bufferedAmount and resolves whenDrained on bufferedamountlow", async () => {
    const { dc, ch } = wrap();
    expect(dc.bufferedAmountLowThreshold).toBe(DRAIN_LOW_WATER);
    expect(ch.bufferedAmount).toBe(0);
    expect(await settled(ch.whenDrained?.() ?? Promise.reject())).toBe(true);

    dc.bufferedAmount = DRAIN_LOW_WATER + 1;
    expect(ch.bufferedAmount).toBe(DRAIN_LOW_WATER + 1);
    const drained = ch.whenDrained?.() ?? Promise.reject();
    expect(await settled(drained)).toBe(false);
    dc.drain();
    expect(await settled(drained)).toBe(true);
  });

  it("whenDrained resolves when the channel closes", async () => {
    const { dc, ch } = wrap();
    dc.bufferedAmount = DRAIN_LOW_WATER * 4;
    const drained = ch.whenDrained?.() ?? Promise.reject();
    dc.close();
    expect(await settled(drained)).toBe(true);
  });
});

describe("(#146) messageTargetOverByteChannel paces by the channel", () => {
  const channel = (over: Partial<ByteChannel> = {}): ByteChannel => {
    let close!: () => void;
    const closed = new Promise<void>((r) => {
      close = r;
    });
    const base: ByteChannel = {
      send: () => {},
      recv: (async function* (): AsyncGenerator<Uint8Array> {
        await closed;
        yield* [];
      })(),
      closed,
      close,
    };
    // Descriptors, not a spread: a getter must stay live.
    return Object.defineProperties(base, Object.getOwnPropertyDescriptors(over));
  };

  it("exposes the channel's bufferedAmount and whenDrained", async () => {
    let buffered = 5;
    let release!: () => void;
    const ch = channel({
      get bufferedAmount() {
        return buffered;
      },
      whenDrained: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    });
    const { target } = messageTargetOverByteChannel(ch);
    expect(target.bufferedAmount).toBe(5);
    buffered = 7;
    expect(target.bufferedAmount).toBe(7);
    const drained = target.whenDrained();
    expect(await settled(drained)).toBe(false);
    release();
    expect(await settled(drained)).toBe(true);
  });

  it("whenDrained resolves at once over a channel that cannot tell, and once the pipe ends", async () => {
    const plain = messageTargetOverByteChannel(channel());
    expect(plain.target.bufferedAmount).toBe(0);
    expect(await settled(plain.target.whenDrained())).toBe(true);

    const stuck = messageTargetOverByteChannel(
      channel({ bufferedAmount: 1e9, whenDrained: () => new Promise<void>(() => {}) }),
    );
    const drained = stuck.target.whenDrained();
    await stuck.target.close();
    expect(await settled(drained)).toBe(true);
  });
});
