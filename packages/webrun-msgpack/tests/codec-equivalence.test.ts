import type { MessageTarget, PortCodec, PortEnvelope } from "@statewalker/webrun-rpc";
import { structuredCodec } from "@statewalker/webrun-rpc";
import { describe, expect, it } from "vitest";
import { msgpackCodec } from "../src/index.js";

function through(codec: PortCodec, envelope: PortEnvelope): PortEnvelope | undefined {
  let sent: unknown;
  const port: MessageTarget = {
    postMessage(message: unknown) {
      sent = message;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  codec.post(port, envelope);
  return codec.read(new MessageEvent("message", { data: sent }));
}

/**
 * Everything layer 2 actually puts on the wire, as `duplexOverPort`,
 * `callPort`/`listenPort` and `multiplexPort` construct it. If a new envelope
 * shape is added later, it belongs in this list.
 */
const LAYER_2_TRAFFIC: Array<[string, PortEnvelope]> = [
  ["open, no meta", { type: "open", id: 0 }],
  ["open, stream meta", { type: "open", id: 2, meta: { kind: "stream" } }],
  ["open, control meta", { type: "open", id: 4, meta: { kind: "control" } }],
  ["close, no reason", { type: "close", id: 0 }],
  ["close, string reason", { type: "close", id: 2, reason: "max-ports" }],
  [
    "chunk request",
    {
      type: "message",
      id: 2,
      payload: {
        type: "request",
        channelName: "in",
        callId: "call-1-2",
        params: { done: false, value: new Uint8Array([1, 2, 3]) },
      },
    },
  ],
  [
    "final chunk",
    {
      type: "message",
      id: 2,
      payload: {
        type: "request",
        channelName: "out",
        callId: "call-1-3",
        params: { done: true },
      },
    },
  ],
  [
    "confirmation",
    {
      type: "message",
      id: 2,
      payload: { type: "response:result", channelName: "in", callId: "call-1-2" },
    },
  ],
  [
    // What `listenPort` (packages/webrun-rpc/src/listen-port.ts) actually posts
    // for a void-returning handler: `port.postMessage({ callId, channelName,
    // type, result, error })` with both `result` and `error` present as own
    // keys, each holding the value `undefined`. The row above omits both keys
    // entirely, which is not the real wire shape — this row is.
    "confirmation, explicit undefined result/error (real listenPort shape)",
    {
      type: "message",
      id: 2,
      payload: {
        type: "response:result",
        channelName: "in",
        callId: "call-1-2",
        result: undefined,
        error: undefined,
      },
    },
  ],
  [
    "error response",
    {
      type: "message",
      id: 2,
      payload: {
        type: "response:error",
        channelName: "out",
        callId: "call-1-4",
        error: { message: "boom", stack: "at x", status: 418, code: "TEAPOT" },
      },
    },
  ],
  ["stream abort notice", { type: "message", id: 2, payload: { type: "webrun-rpc:stream-abort" } }],
];

describe("the two codecs agree on everything layer 2 sends (spec D16)", () => {
  for (const [label, envelope] of LAYER_2_TRAFFIC) {
    it(`${label} survives both codecs identically`, () => {
      const viaStructured = through(structuredCodec, envelope);
      const viaMsgpack = through(msgpackCodec, envelope);
      expect(viaStructured).toBeDefined();
      expect(viaMsgpack).toBeDefined();
      // Note: for the "explicit undefined result/error" row, structuredCodec's
      // output keeps `result`/`error` as own keys (value `undefined`) while
      // msgpackCodec's output drops them entirely (see the asymmetry test
      // below). This still passes: Vitest's `toEqual` treats an
      // explicitly-`undefined` property as equivalent to an absent one, so
      // the two shapes compare equal here even though `Object.keys` differs.
      // That is measured, not assumed — see the probe in task-2-report.md.
      expect(viaMsgpack).toEqual(viaStructured);
    });
  }
});

describe("where the two codecs differ, and it is on purpose", () => {
  it("msgpack drops an explicitly-undefined key; structured clone keeps it", () => {
    // This is the one asymmetry, and it is the shape spec risk R4 warns about:
    // invisible in development over a MessagePort, visible only over bytes.
    // It is benign today because every consumer tests `error ? … : undefined`,
    // where missing and undefined are both falsy. It must stay benign.
    const envelope = {
      type: "message",
      id: 2,
      payload: { done: true, value: undefined, error: undefined },
    } as PortEnvelope;

    const viaStructured = through(structuredCodec, envelope) as { payload: object };
    const viaMsgpack = through(msgpackCodec, envelope) as { payload: object };

    expect("error" in viaStructured.payload).toBe(true);
    expect("error" in viaMsgpack.payload).toBe(false);
    // The floor: what actually matters — reading the key — agrees.
    expect((viaStructured.payload as { error?: unknown }).error).toBeUndefined();
    expect((viaMsgpack.payload as { error?: unknown }).error).toBeUndefined();
  });

  it("both refuse traffic that is not theirs", () => {
    const notOurs = new MessageEvent("message", { data: { hello: "world" } });
    expect(structuredCodec.read(notOurs)).toBeUndefined();
    expect(msgpackCodec.read(notOurs)).toBeUndefined();
  });
});
