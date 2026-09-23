import type { BrokerEvent } from "./broker.js";

/**
 * JSON for the wire. Total by construction: `JSON.stringify` returns `undefined`
 * rather than a string for `undefined`, a function or a symbol, and throws on a
 * BigInt or a circular object. Any of those is framed as `null` — the event still
 * reaches the client with its id and name, which is what an empty signal is for.
 */
function serialize(data: unknown): string {
  try {
    return JSON.stringify(data) ?? "null";
  } catch {
    return "null";
  }
}

/**
 * Format one WHATWG Server-Sent Event frame, terminated by the blank line that
 * ends an event.
 *
 * `data` is always JSON-serialized, strings included (a string payload arrives
 * back through `JSON.parse` as the same string, never half-decoded). JSON escapes
 * newlines, so the body is a single line in practice; every line is prefixed
 * anyway, because an unframed newline would end the event and truncate it.
 *
 * CR and LF are stripped from the event name: it is caller-supplied, and a
 * newline there would inject whole frames onto the wire.
 */
export function formatSseEvent(e: BrokerEvent): string {
  const lines = serialize(e.data)
    .split("\n")
    .map((l) => `data: ${l}\n`)
    .join("");
  const name = e.event === undefined ? "" : `event: ${e.event.replace(/[\r\n]/g, "")}\n`;
  return `id: ${e.id}\n${name}${lines}\n`;
}
