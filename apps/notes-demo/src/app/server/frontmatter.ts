/**
 * Notes are stored as markdown files with a minimal frontmatter header:
 *
 *     ---
 *     id: <id>
 *     title: <title>
 *     createdAt: <iso>
 *     updatedAt: <iso>
 *     ---
 *     <markdown body…>
 *
 * Pure functions, no YAML dependency. The header is a flat `key: value` block
 * delimited by two `---` lines; the body is everything after the second `---`.
 */

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const HEADER_KEYS = ["id", "title", "createdAt", "updatedAt"] as const;

// Header values are one-per-line, so a raw newline (or backslash) in a value —
// e.g. a pasted multi-line title — would corrupt the header or inject a field.
// Escape on write, reverse on read; normal single-line values are unchanged.
const escapeValue = (v: string): string =>
  v.replace(/[\\\n\r]/g, (c) => (c === "\\" ? "\\\\" : c === "\n" ? "\\n" : "\\r"));
const unescapeValue = (v: string): string =>
  v.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c));

/** Serialize a note to markdown-with-frontmatter. */
export function serializeNote(note: Note): string {
  const header = HEADER_KEYS.map((key) => `${key}: ${escapeValue(note[key])}`).join("\n");
  return `---\n${header}\n---\n${note.body}`;
}

/**
 * Parse markdown-with-frontmatter back into a note. `id` from the filename is
 * authoritative. A text with no leading `---` header is treated as a bare body.
 */
export function parseNote(id: string, text: string): Note {
  const note: Note = { id, title: "", body: text, createdAt: "", updatedAt: "" };
  if (!text.startsWith("---\n")) return note;

  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return note;

  const header = text.slice(4, end);
  note.body = text.slice(end + 5);
  for (const line of header.split("\n")) {
    const sep = line.indexOf(": ");
    if (sep === -1) continue;
    const key = line.slice(0, sep);
    const value = unescapeValue(line.slice(sep + 2));
    if (key === "title") note.title = value;
    else if (key === "createdAt") note.createdAt = value;
    else if (key === "updatedAt") note.updatedAt = value;
  }
  return note;
}
