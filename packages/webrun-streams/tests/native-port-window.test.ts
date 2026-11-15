import { describe, expect, it } from "vitest";
import {
  CONTROL_BYTE,
  MIN_PORT_WINDOW,
  type NativeChannel,
  newMessagePipe,
  newNativePortMux,
  PORT_FLOW,
} from "../src/index.js";

const json = {
  encode: (v: unknown) => new TextEncoder().encode(JSON.stringify(v)),
  decode: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)),
};

/** One end of a channel whose other end is the test: `sent` is what the port wrote, `deliver` feeds it. */
function rawChannel() {
  const sent: Uint8Array[] = [];
  const control = newMessagePipe({ send: (b) => void sent.push(b.slice()) }, { name: "raw" });
  return {
    channel: { pipe: control.pipe.target } as NativeChannel,
    sent,
    deliver: control.deliver,
  };
}

function hello(window: number): Uint8Array {
  const f = new Uint8Array(6);
  f[0] = CONTROL_BYTE;
  f[1] = 1;
  new DataView(f.buffer).setUint32(2, window);
  return f;
}

describe("native port window: the floor (statewalker/webrun-wire#153)", () => {
  it("a window below 64 KiB is refused", () => {
    expect(() =>
      newNativePortMux({
        name: "t",
        codec: json,
        maxMessageSize: 1,
        window: MIN_PORT_WINDOW - 1,
        open: async () => rawChannel().channel,
      }),
    ).toThrow(RangeError);
  });

  it("an agreed port says hello first, and holds back by the floor before the peer's hello", async () => {
    const raw = rawChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: 1024 * 1024,
      open: async () => ({ ...raw.channel, window: "agreed" }),
    });
    const port = await control.mux.openPort();
    expect(raw.sent[0]).toEqual(hello(1024 * 1024));
    const body = "a".repeat(40 * 1024);
    port.postMessage(body);
    port.postMessage(body);
    // The second would pass the 64 KiB floor: it waits for the peer's hello.
    expect(raw.sent.length).toBe(2);
    raw.deliver(hello(4 * 1024 * 1024));
    expect(raw.sent.length).toBe(3);
  });

  it("a hello below the floor fails the port", async () => {
    const raw = rawChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: 1024 * 1024,
      open: async () => ({ ...raw.channel, window: "agreed" }),
    });
    const port = await control.mux.openPort();
    raw.deliver(hello(1024));
    expect(port.closeSignal.aborted).toBe(true);
    expect(String((port.closeSignal.reason as Error).message)).toMatch(/control frame/);
  });

  it("a hello on a port the peer opened does not make this end presume for the ports it offers (review of #184)", async () => {
    const inbound = rawChannel();
    const outbound = rawChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: 1024 * 1024,
      onPort: () => true,
      open: async () => ({ ...outbound.channel, window: "offered" }),
    });
    // The peer's opening mux has a window: its hello arrives on the port it opened.
    control.accept({ ...inbound.channel, window: "agreed" }, {});
    inbound.deliver(hello(1024 * 1024));
    // The mux serving this end's ports may be another one, without a window:
    // an offered port says nothing until that mux answers.
    const port = await control.mux.openPort();
    port.postMessage("hi");
    expect(outbound.sent.length).toBe(1);
    expect(outbound.sent[0]?.[0]).not.toBe(CONTROL_BYTE);
  });
});

/**
 * A channel whose transport the test fills and drains: `full` holds what the
 * transport reports as buffered past its low-water mark, `drain()` empties it
 * and fires its drain event (statewalker/webrun-wire#195).
 */
function fillableChannel(lowWater = 1024) {
  const sent: Uint8Array[] = [];
  let buffered = 0;
  let onDrain: (() => void)[] = [];
  const failed: Error[] = [];
  const control = newMessagePipe(
    {
      send: (b) => {
        sent.push(b.slice());
      },
      bufferedAmount: () => buffered,
      whenDrained: () => new Promise<void>((resolve) => onDrain.push(resolve)),
    },
    { name: "fillable", drainLowWater: lowWater },
  );
  return {
    channel: {
      pipe: control.pipe.target,
      fail: (reason: Error) => {
        failed.push(reason);
        control.end(reason, true);
      },
    } as NativeChannel,
    sent,
    failed,
    deliver: control.deliver,
    fill(bytes: number) {
      buffered = bytes;
    },
    drain() {
      buffered = 0;
      const waiting = onDrain;
      onDrain = [];
      for (const resolve of waiting) resolve();
    },
  };
}

const dataBytes = (frames: Uint8Array[]): number =>
  frames.filter((f) => f[0] !== CONTROL_BYTE).reduce((n, f) => n + f.byteLength, 0);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("native port window: a bounded send-ahead (statewalker/webrun-wire#195)", () => {
  it("the peer's hello is clamped to this end's own window", async () => {
    const raw = rawChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: 256 * 1024,
      open: async () => ({ ...raw.channel, window: "agreed" }),
    });
    const port = await control.mux.openPort();
    // The peer grants the most a hello can carry: 4 GiB less one byte.
    raw.deliver(hello(0xffffffff));
    const body = "a".repeat(16 * 1024);
    for (let i = 0; i < 128; i++) port.postMessage(body); // 2 MiB
    // At most this end's own window in flight, plus the one message that crossed it.
    expect(dataBytes(raw.sent)).toBeLessThanOrEqual(256 * 1024 + 16 * 1024 + 16);
    expect(dataBytes(raw.sent)).toBeGreaterThanOrEqual(256 * 1024 - 16 * 1024);
  });

  it("nothing more goes on a transport that needs to drain: it waits in the port's queue", async () => {
    const ch = fillableChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: 4 * 1024 * 1024,
      open: async () => ({ ...ch.channel, window: "agreed" }),
    });
    const port = await control.mux.openPort();
    ch.deliver(hello(4 * 1024 * 1024));
    const body = "a".repeat(16 * 1024);
    port.postMessage(body);
    const before = dataBytes(ch.sent);
    expect(before).toBeGreaterThan(0);
    ch.fill(1024 * 1024); // the transport is full
    for (let i = 0; i < 16; i++) port.postMessage(body);
    expect(dataBytes(ch.sent)).toBe(before);
    const flow = port[PORT_FLOW];
    expect(flow?.bufferedAmount()).toBeGreaterThan(0);
    ch.drain();
    await tick();
    expect(dataBytes(ch.sent)).toBeGreaterThan(before);
    expect(flow?.bufferedAmount()).toBe(0);
  });

  it("a write that waits for drain longer than `drainTimeoutMs` fails the port and breaks off its channel", async () => {
    const ch = fillableChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: 4 * 1024 * 1024,
      drainTimeoutMs: 50,
      open: async () => ({ ...ch.channel, window: "agreed" }),
    });
    const port = await control.mux.openPort();
    ch.deliver(hello(4 * 1024 * 1024));
    ch.fill(1024 * 1024);
    port.postMessage("a");
    expect(port.closeSignal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(port.closeSignal.aborted).toBe(true);
    expect(String((port.closeSignal.reason as Error).message)).toMatch(/drain/);
    expect(ch.failed.length).toBe(1);
  });

  it("a quiet port is never failed: only a write blocked on drain counts", async () => {
    const ch = fillableChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: 4 * 1024 * 1024,
      drainTimeoutMs: 50,
      open: async () => ({ ...ch.channel, window: "agreed" }),
    });
    const port = await control.mux.openPort();
    ch.deliver(hello(4 * 1024 * 1024));
    port.postMessage("a");
    // Full, but nothing waits to go: a quiet exchange (an SSE stream between events).
    ch.fill(1024 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(port.closeSignal.aborted).toBe(false);
    // A write that waits, then drains in time: not failed either.
    port.postMessage("b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    ch.drain();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(port.closeSignal.aborted).toBe(false);
    expect(ch.failed.length).toBe(0);
  });

  it("a message pipe says whether its transport needs to drain", () => {
    const ch = fillableChannel(1024);
    expect(ch.channel.pipe.needsDrain).toBe(false);
    ch.fill(2048);
    expect(ch.channel.pipe.needsDrain).toBe(true);
  });
});

/** The credit frames among `frames`, as the bytes each grants. */
const credits = (frames: Uint8Array[]): number[] =>
  frames
    .filter((f) => f[0] === CONTROL_BYTE && f[1] === 2)
    .map((f) => new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(2));

describe("native port window: credit on a full transport (review of #196)", () => {
  /** An agreed port with a 64 KiB window whose listener consumes every message at once. */
  async function uploadingPort(drainTimeoutMs?: number) {
    const ch = fillableChannel();
    const control = newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: MIN_PORT_WINDOW,
      ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
      open: async () => ({ ...ch.channel, window: "agreed" }),
    });
    const port = await control.mux.openPort();
    port.addEventListener("message", () => {});
    ch.deliver(hello(MIN_PORT_WINDOW));
    await tick();
    const frame = json.encode("u".repeat(20 * 1024));
    return { ch, port, frame };
  }

  it("no credit goes on a transport that needs to drain; one combined credit goes after it drains", async () => {
    const { ch, port, frame } = await uploadingPort();
    ch.fill(1024 * 1024); // the peer stopped reading this end's bytes
    const before = ch.sent.length;
    for (let i = 0; i < 100; i++) ch.deliver(frame); // and keeps uploading
    await tick();
    await tick();
    expect(credits(ch.sent.slice(before))).toEqual([]);
    ch.drain();
    await tick();
    await tick();
    const granted = credits(ch.sent.slice(before));
    expect(granted.length).toBe(1);
    expect(granted[0]).toBe(100 * frame.byteLength);
    expect(port.closeSignal.aborted).toBe(false);
  });

  it("credit held back for drain longer than `drainTimeoutMs` fails the port", async () => {
    const { ch, port, frame } = await uploadingPort(50);
    ch.fill(1024 * 1024);
    for (let i = 0; i < 10; i++) ch.deliver(frame);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(port.closeSignal.aborted).toBe(true);
    expect(String((port.closeSignal.reason as Error).message)).toMatch(/drain/);
    expect(ch.failed.length).toBe(1);
  });
});

describe("native port window: `drainTimeoutMs` values (review of #196)", () => {
  const make = (drainTimeoutMs: number, ch = fillableChannel()) =>
    newNativePortMux({
      name: "t",
      codec: json,
      maxMessageSize: 1,
      window: MIN_PORT_WINDOW,
      drainTimeoutMs,
      open: async () => ({ ...ch.channel, window: "agreed" }),
    });

  it("0 and Infinity mean no bound; a negative number or NaN is refused", () => {
    expect(() => make(0)).not.toThrow();
    expect(() => make(Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => make(-1)).toThrow(RangeError);
    expect(() => make(Number.NaN)).toThrow(RangeError);
  });

  for (const value of [0, Number.POSITIVE_INFINITY, 2 ** 32]) {
    it(`${value}: a write blocked on drain is not failed at once`, async () => {
      const ch = fillableChannel();
      const port = await make(value, ch).mux.openPort();
      ch.deliver(hello(MIN_PORT_WINDOW));
      ch.fill(1024 * 1024);
      port.postMessage("a");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(port.closeSignal.aborted).toBe(false);
      await port.close();
    });
  }
});
