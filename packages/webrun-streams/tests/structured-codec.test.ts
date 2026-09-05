import { describe, expect, it } from "vitest";
import type { PortEnvelope } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

/** A MessageTarget stub that records what was posted. */
function recordingPort() {
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  return {
    posted,
    port: {
      addEventListener() {},
      removeEventListener() {},
      postMessage(message: unknown, transfer?: Transferable[]) {
        posted.push({ message, transfer });
      },
    },
  };
}

const asEvent = (data: unknown): MessageEvent => new MessageEvent("message", { data });

describe("structuredCodec", () => {
  it("posts the envelope unchanged, without encoding it", () => {
    const { port, posted } = recordingPort();
    const envelope: PortEnvelope = { type: "message", id: 4, payload: { hello: "world" } };
    structuredCodec.post(port, envelope);
    expect(posted).toHaveLength(1);
    // Identity, not deep equality: the whole point is that nothing is encoded.
    expect(posted[0]?.message).toBe(envelope);
  });

  it("forwards a transfer list so ArrayBuffers move zero-copy", () => {
    const { port, posted } = recordingPort();
    const buffer = new ArrayBuffer(8);
    structuredCodec.post(port, { type: "message", id: 2, payload: buffer }, [buffer]);
    expect(posted[0]?.transfer).toEqual([buffer]);
  });

  it("omits the transfer argument entirely when there is nothing to transfer", () => {
    const { port, posted } = recordingPort();
    structuredCodec.post(port, { type: "message", id: 2, payload: 1 }, []);
    // An empty array is not the same as absent: some MessageTarget
    // implementations reject an empty transfer list.
    expect(posted[0]?.transfer).toBeUndefined();
  });

  it("reads back each envelope type", () => {
    expect(structuredCodec.read(asEvent({ type: "open", id: 0 }))).toEqual({ type: "open", id: 0 });
    expect(structuredCodec.read(asEvent({ type: "message", id: 1, payload: "x" }))).toEqual({
      type: "message",
      id: 1,
      payload: "x",
    });
    expect(structuredCodec.read(asEvent({ type: "close", id: 2, reason: "why" }))).toEqual({
      type: "close",
      id: 2,
      reason: "why",
    });
  });

  it("ignores traffic that is not an envelope", () => {
    // A port may legitimately carry other people's messages. Claiming them
    // would corrupt an application that shares the transport.
    expect(structuredCodec.read(asEvent(undefined))).toBeUndefined();
    expect(structuredCodec.read(asEvent(null))).toBeUndefined();
    expect(structuredCodec.read(asEvent("hello"))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "message" }))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "nope", id: 0 }))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "message", id: -1 }))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "message", id: 1.5 }))).toBeUndefined();
  });
});
