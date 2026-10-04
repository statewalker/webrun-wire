import { describe, expect, it } from "vitest";
import { formatSseEvent } from "./sse.js";

describe("formatSseEvent", () => {
  it("frames id, event name and data", () => {
    expect(formatSseEvent({ id: 7, event: "rebuilt", data: { a: 1 } })).toBe(
      'id: 7\nevent: rebuilt\ndata: {"a":1}\n\n',
    );
  });

  it("omits the event line when no name is given", () => {
    expect(formatSseEvent({ id: 1, data: 5 })).toBe("id: 1\ndata: 5\n\n");
  });

  // (3) an unframed newline terminates the event early and truncates the payload
  it("emits one data line per newline in the payload", () => {
    const frame = formatSseEvent({ id: 2, data: "line one\nline two" });
    expect(frame).toBe('id: 2\ndata: "line one\\nline two"\n\n');
  });

  it("splits a multi-line serialized payload across data lines", () => {
    const frame = formatSseEvent({ id: 3, data: { raw: "a\nb" }, event: "e" });
    // JSON.stringify escapes the newline, so exactly one data line results
    expect(frame.split("\n").filter((l) => l.startsWith("data:"))).toHaveLength(1);
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

describe("formatSseEvent — total on any input", () => {
  // C-1: JSON.stringify returns undefined (not a string) for these, so `.split` threw
  // and the throw escaped every guard in the handler and the broker.
  it("frames a payload JSON cannot represent as null instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatSseEvent({ id: 1, event: "reload", data: undefined })).toBe(
      "id: 1\nevent: reload\ndata: null\n\n",
    );
    expect(formatSseEvent({ id: 2, data: () => {} })).toBe("id: 2\ndata: null\n\n");
    expect(formatSseEvent({ id: 3, data: Symbol("s") })).toBe("id: 3\ndata: null\n\n");
    expect(formatSseEvent({ id: 4, data: 1n })).toBe("id: 4\ndata: null\n\n");
    expect(formatSseEvent({ id: 5, data: circular })).toBe("id: 5\ndata: null\n\n");
  });

  // m-10: a newline in the event name used to inject whole frames onto the wire.
  it("cannot be made to inject a frame through the event name", () => {
    const frame = formatSseEvent({ id: 1, event: "a\ndata: injected\r\nevent: x", data: 0 });
    expect(frame.split("\n").filter((l) => l.startsWith("data:"))).toEqual(["data: 0"]);
    expect(frame).toBe("id: 1\nevent: adata: injectedevent: x\ndata: 0\n\n");
  });

  // m-9: the doc comment used to promise special handling for a pre-serialized
  // string; it never happened. A string is JSON-encoded like anything else.
  it("JSON-encodes a string payload like any other value", () => {
    expect(formatSseEvent({ id: 1, data: "hi" })).toBe('id: 1\ndata: "hi"\n\n');
  });
});
