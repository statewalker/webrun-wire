import { describe, expect, it } from "vitest";
import {
  CONTROL_BYTE,
  MIN_PORT_WINDOW,
  type NativeChannel,
  newMessagePipe,
  newNativePortMux,
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
});
