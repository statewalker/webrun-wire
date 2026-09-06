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
 * Every envelope *shape* layer 2's sources (`duplexOverPort`,
 * `callPort`/`listenPort` and `multiplexPort`) construct, paired where a
 * field's key can be either absent or present-with-`undefined` at different
 * call sites — both are real, and each row below says which line posts it.
 * If a new shape is added later, it belongs in this list.
 *
 * A caution learned the hard way: a row that merely *looks* plausible is not
 * the same as a row a source line actually posts. Every row here was checked
 * against the `post`/`postMessage` call site named in its comment, not
 * inferred from the envelope's TypeScript type (which allows keys to be
 * optional even where a given call site always supplies them, undefined or
 * not).
 */
const LAYER_2_TRAFFIC: Array<[string, PortEnvelope]> = [
  [
    // No source posts this exact shape (`meta` absent as a key). It is
    // included as the key-absent baseline the sibling row below is paired
    // against — not itself real wire traffic.
    "open, no meta (key absent — not a real wire shape, see sibling below)",
    { type: "open", id: 0 },
  ],
  [
    // multiplex-port.ts:118, `openPort(meta?)` called with no argument:
    // `post({ type: "open", id, meta })` — `meta` is always an own key of the
    // posted object, even when its value is `undefined`.
    "open, meta explicitly undefined (real multiplexPort shape, multiplex-port.ts:118)",
    { type: "open", id: 0, meta: undefined },
  ],
  ["open, stream meta", { type: "open", id: 2, meta: { kind: "stream" } }],
  ["open, control meta", { type: "open", id: 4, meta: { kind: "control" } }],
  [
    // multiplex-port.ts:125, inside `close()`'s teardown loop:
    // `post({ type: "close", id })` — no `reason` key at all. This is a
    // genuinely distinct real shape from the next two rows, not a stand-in.
    "close, no reason (real multiplexPort teardown shape, multiplex-port.ts:125)",
    { type: "close", id: 0 },
  ],
  [
    // multiplex-port.ts:42, the virtual port's closer callback
    // (`requestClose: (reason?) => void` in virtual-port.ts) called with no
    // argument: `post({ type: "close", id, reason })` — `reason` is always an
    // own key here, unlike the teardown call site above.
    "close, reason explicitly undefined (real multiplexPort shape, multiplex-port.ts:42)",
    { type: "close", id: 0, reason: undefined },
  ],
  [
    // multiplex-port.ts:59, when `open.size >= maxPorts`.
    "close, string reason (max-ports, multiplex-port.ts:59)",
    { type: "close", id: 2, reason: "max-ports" },
  ],
  [
    // multiplex-port.ts:74, when `onPort` rejects an incoming open.
    "close, string reason (rejected, multiplex-port.ts:74)",
    { type: "close", id: 2, reason: "rejected" },
  ],
  [
    // Key-absent baseline (no source posts a chunk without an `error` key —
    // see the sibling row below); paired for the same reason as "open, no
    // meta" above.
    "chunk request (key-absent baseline — not a real wire shape, see sibling below)",
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
    // duplex-over-port.ts:452, `sendChunks`: `const chunk: WireChunk = {
    // done, value, error: error === undefined ? undefined : serializeError(error) };`
    // — `done`, `value` and `error` are unconditionally own keys of every
    // chunk sent as `callPort`'s `params`.
    "chunk request, explicit undefined error (real duplexOverPort shape, duplex-over-port.ts:452)",
    {
      type: "message",
      id: 2,
      payload: {
        type: "request",
        channelName: "in",
        callId: "call-1-2",
        params: { done: false, value: new Uint8Array([1, 2, 3]), error: undefined },
      },
    },
  ],
  [
    // Key-absent baseline, paired with the sibling below for the same reason.
    "final chunk (key-absent baseline — not a real wire shape, see sibling below)",
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
    // Same call site as "chunk request" above (duplex-over-port.ts:452): the
    // final item off the source iterator carries `done: true` with no chunk
    // of its own, so `value` and `error` are both own keys holding `undefined`.
    "final chunk, explicit undefined value and error (real duplexOverPort shape, duplex-over-port.ts:452)",
    {
      type: "message",
      id: 2,
      payload: {
        type: "request",
        channelName: "out",
        callId: "call-1-3",
        params: { done: true, value: undefined, error: undefined },
      },
    },
  ],
  [
    // Key-absent baseline, paired with the sibling below for the same reason.
    "confirmation (key-absent baseline — not a real wire shape, see sibling below)",
    {
      type: "message",
      id: 2,
      payload: { type: "response:result", channelName: "in", callId: "call-1-2" },
    },
  ],
  [
    // listen-port.ts:43, `port.postMessage({ callId, channelName, type,
    // result, error })`, void-handler success path: `result` and `error` are
    // both unconditionally own keys, each holding `undefined`.
    "confirmation, explicit undefined result/error (real listenPort shape, listen-port.ts:43)",
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
    // Key-absent baseline (omits `result`) — see the sibling row below.
    "error response (key-absent baseline — not a real wire shape, see sibling below)",
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
  [
    // Same call site as the confirmation row (listen-port.ts:43): the
    // `postMessage` call is unconditional across both the success and error
    // branches, so on the error path `result` is still an own key, holding
    // `undefined`, alongside the real `error` payload.
    "error response, explicit undefined result (real listenPort shape, listen-port.ts:43)",
    {
      type: "message",
      id: 2,
      payload: {
        type: "response:error",
        channelName: "out",
        callId: "call-1-4",
        result: undefined,
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
      // Note: for every "explicit undefined <key>" row above, structuredCodec's
      // output keeps that key as an own property (value `undefined`) while
      // msgpackCodec's output drops it entirely (see the asymmetry test
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

    // The structured-clone leg below is not exercising real structured clone:
    // this test harness's fake port never clones (`postMessage` just records
    // the reference, and `structuredCodec.post`/`.read` do no cloning of
    // their own — see structured-codec.ts, which relies on the platform's
    // clone at a real port boundary). So `viaStructured.payload` here is the
    // same object as the `envelope.payload` literal above, and this
    // assertion is really "the key we wrote is still there" — true of this
    // harness by construction, and separately confirmed to also hold under a
    // real `structuredClone` (see task-2-report.md). The msgpack leg below it
    // is the one that actually exercises encode/decode and is load-bearing.
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
