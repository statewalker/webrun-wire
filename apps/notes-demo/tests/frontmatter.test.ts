import { describe, expect, it } from "vitest";
import { parseNote, serializeNote } from "../src/app/server/frontmatter.ts";

describe("frontmatter", () => {
  it("round-trips serialize → parse", () => {
    const note = {
      id: "abc-123",
      title: "Hello",
      body: "# Heading\n\nA paragraph.",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T01:00:00.000Z",
    };
    const parsed = parseNote(note.id, serializeNote(note));
    expect(parsed).toEqual(note);
  });

  it("preserves a multi-line markdown body verbatim (no header leakage)", () => {
    const body = "## Title\n\n- one\n- two\n\nlast line";
    const text = serializeNote({
      id: "x",
      title: "T",
      body,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const parsed = parseNote("x", text);
    expect(parsed.body).toBe(body);
    expect(parsed.body).not.toContain("---");
    expect(parsed.body).not.toContain("title:");
  });

  it("round-trips a title containing newlines and backslashes without corruption", () => {
    // A pasted multi-line title must not break the one-line-per-key header or
    // inject a field like `updatedAt:`.
    const note = {
      id: "esc-1",
      title: "line one\nupdatedAt: 1999\tand a \\ backslash",
      body: "body\nstays\nintact",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T02:00:00.000Z",
    };
    const parsed = parseNote(note.id, serializeNote(note));
    expect(parsed).toEqual(note);
    expect(parsed.updatedAt).toBe("2026-07-26T02:00:00.000Z"); // not hijacked by the title
  });

  it("tolerates a note with no frontmatter (whole text is the body)", () => {
    const parsed = parseNote("plain", "just a body, no header");
    expect(parsed.id).toBe("plain");
    expect(parsed.body).toBe("just a body, no header");
    expect(parsed.title).toBe("");
  });
});
