import type { BrokerEvent } from "./broker.js";

/**
 * Format one WHATWG Server-Sent Event frame, terminated by the blank line
 * that ends an event. `data` is JSON-serialized; because JSON escapes
 * newlines, a serialized payload is always a single line — but a caller
 * passing a pre-serialized string may not be, so every line is prefixed.
 */
export function formatSseEvent(e: BrokerEvent): string {
  const body = typeof e.data === "string" ? JSON.stringify(e.data) : JSON.stringify(e.data);
  const lines = body.split("\n").map((l) => `data: ${l}\n`).join("");
  return `id: ${e.id}\n${e.event === undefined ? "" : `event: ${e.event}\n`}${lines}\n`;
}
