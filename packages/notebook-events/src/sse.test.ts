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
