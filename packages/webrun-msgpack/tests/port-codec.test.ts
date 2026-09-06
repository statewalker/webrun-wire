import type { MessageTarget, PortEnvelope } from "@statewalker/webrun-rpc";
import { describe, expect, it } from "vitest";
import { msgpackCodec } from "../src/index.js";

/** A one-shot sink that records what was posted, plus the transfer list. */
function recordingPort(): MessageTarget & {
  sent: unknown[];
  transfers: (Transferable[] | undefined)[];
} {
  const sent: unknown[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  return {
    sent,
    transfers,
    postMessage(message: unknown, transfer?: Transferable[]) {
      sent.push(message);
      transfers.push(transfer);
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Build the MessageEvent shape `read` is given, without a real port. */
function event(data: unknown): MessageEvent {
  return new MessageEvent("message", { data });
}

/** Post an envelope and read it straight back — one full trip through the codec. */
function roundTrip(envelope: PortEnvelope): PortEnvelope | undefined {
  const port = recordingPort();
  msgpackCodec.post(port, envelope);
  return msgpackCodec.read(event(port.sent[0]));
}

describe("msgpackCodec — round trip", () => {
  it("carries an open envelope with meta", () => {
    expect(roundTrip({ type: "open", id: 0, meta: { kind: "stream" } })).toEqual({
      type: "open",
      id: 0,
      meta: { kind: "stream" },
    });
  });

  it("carries a close envelope with an opaque reason", () => {
    expect(roundTrip({ type: "close", id: 3, reason: "rejected" })).toEqual({
      type: "close",
      id: 3,
      reason: "rejected",
    });
  });

  it("carries a Uint8Array payload byte-for-byte", () => {
    const value = new Uint8Array([0, 1, 127, 128, 255]);
    const out = roundTrip({
      type: "message",
      id: 2,
      payload: { type: "request", channelName: "in", callId: "c1", params: { done: false, value } },
    });
    const back = (out as { payload: { params: { value: Uint8Array } } }).payload.params.value;
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Array.from(back)).toEqual([0, 1, 127, 128, 255]);
  });

  it("carries an empty Uint8Array as an empty Uint8Array", () => {
    const out = roundTrip({
      type: "message",
      id: 4,
      payload: { params: { done: false, value: new Uint8Array(0) } },
    });
    const back = (out as { payload: { params: { value: Uint8Array } } }).payload.params.value;
    expect(back).toBeInstanceOf(Uint8Array);
    expect(back.byteLength).toBe(0);
  });

  it("carries a serialised error's custom fields and stack", () => {
    const out = roundTrip({
      type: "message",
      id: 6,
      payload: {
        type: "response:error",
        channelName: "out",
        callId: "c2",
        error: { message: "boom", stack: "at x", status: 418, code: "TEAPOT" },
      },
    });
    expect((out as { payload: { error: unknown } }).payload.error).toEqual({
      message: "boom",
      stack: "at x",
      status: 418,
      code: "TEAPOT",
    });
  });

  it("posts one message per envelope, and no transfer list", () => {
    // The payload is inside the bytes, so there is nothing left to transfer.
    // An empty transfer list is not the same as none — some implementations
    // reject the former — so the codec must pass none at all.
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: 2, payload: { a: 1 } }, [
      new ArrayBuffer(8) as Transferable,
    ]);
    expect(port.sent.length).toBe(1);
    expect(port.sent[0]).toBeInstanceOf(Uint8Array);
    expect(port.transfers[0]).toBeUndefined();
  });
});

describe("msgpackCodec — what it refuses, without throwing", () => {
  // Each of these is an absence assertion. Their floor is the round-trip
  // block above and the final test in this block: a codec that returned
  // `undefined` for everything would pass all the refusals and fail those.
  const junk: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "not bytes"],
    ["a plain object", { type: "message", id: 1 }],
    ["empty bytes", new Uint8Array(0)],
    ["invalid msgpack", new Uint8Array([0xc1, 0xff, 0x00])],
  ];

  for (const [label, data] of junk) {
    it(`ignores ${label} and does not throw`, () => {
      expect(() => msgpackCodec.read(event(data))).not.toThrow();
      expect(msgpackCodec.read(event(data))).toBeUndefined();
    });
  }

  it("ignores a truncated frame and does not throw", () => {
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: 2, payload: { a: 1 } });
    const whole = port.sent[0] as Uint8Array;
    const cut = whole.subarray(0, whole.byteLength - 3);
    expect(() => msgpackCodec.read(event(cut))).not.toThrow();
    expect(msgpackCodec.read(event(cut))).toBeUndefined();
  });

  it("ignores well-formed msgpack that is not an envelope", () => {
    const port = recordingPort();
    // Valid msgpack, wrong shape — a shared transport's own traffic.
    msgpackCodec.post(port, { hello: "world" } as unknown as PortEnvelope);
    expect(msgpackCodec.read(event(port.sent[0]))).toBeUndefined();
  });

  it("accepts an ArrayBuffer and an offset view, not only a tight Uint8Array", () => {
    // A transport pump may hand over either. Measured: @ygoe/msgpack decodes
    // an offset subarray correctly, so no defensive copy is needed — but the
    // codec must still accept the shapes.
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: 8, payload: { a: 1 } });
    const tight = port.sent[0] as Uint8Array;

    const asBuffer = tight.slice().buffer;
    expect(msgpackCodec.read(event(asBuffer))).toEqual({
      type: "message",
      id: 8,
      payload: { a: 1 },
    });

    const padded = new Uint8Array(tight.byteLength + 8);
    padded.set(tight, 4);
    const view = padded.subarray(4, 4 + tight.byteLength);
    expect(msgpackCodec.read(event(view))).toEqual({ type: "message", id: 8, payload: { a: 1 } });
  });

  it("accepts a DataView, not only a Uint8Array-shaped view", () => {
    // A `subarray` is still a `Uint8Array`, so the previous test never reaches
    // `toBytes`'s `ArrayBuffer.isView` branch — it returns one line earlier.
    // A `DataView` is the shape that actually forces that branch, offset and
    // length arithmetic included: it shares `padded`'s backing buffer at the
    // same non-zero offset, so a `toBytes` that dropped `byteOffset`/
    // `byteLength` (e.g. `new Uint8Array(view.buffer)`) would read from the
    // wrong place — either zeros at the front or the wrong length — not this
    // envelope.
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: 8, payload: { a: 1 } });
    const tight = port.sent[0] as Uint8Array;

    const padded = new Uint8Array(tight.byteLength + 8);
    padded.set(tight, 4);
    const dataView = new DataView(padded.buffer, 4, tight.byteLength);
    expect(msgpackCodec.read(event(dataView))).toEqual({
      type: "message",
      id: 8,
      payload: { a: 1 },
    });
  });

  it("ignores a well-formed envelope shape with a non-integer or negative id", () => {
    // Valid type, invalid id — the id checks in `isEnvelope` are what reject
    // these, not the type check (which passes both).
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: -1, payload: { a: 1 } });
    expect(msgpackCodec.read(event(port.sent[0]))).toBeUndefined();

    const port2 = recordingPort();
    // `id: number` does not itself forbid a non-integer.
    msgpackCodec.post(port2, { type: "message", id: 1.5, payload: { a: 1 } });
    expect(msgpackCodec.read(event(port2.sent[0]))).toBeUndefined();
  });
});
