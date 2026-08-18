import { jsonEnvelopeCodec } from "./envelope.js";
import { httpCodec } from "./http1/index.js";
import type { MessageCodec } from "./message.js";
import { newSniffingCodec } from "./sniff.js";

/**
 * Writes HTTP/1.1; accepts HTTP/1.1 or the legacy JSON envelope. Used whenever
 * no `codec` option is supplied.
 */
export const defaultCodec: MessageCodec = newSniffingCodec({
  write: httpCodec,
  accept: [httpCodec, jsonEnvelopeCodec],
});
