import { ByteReader } from "./bytes.js";
import type { ByteSource, MessageCodec } from "./message.js";

export type SniffingCodecOptions = {
  /** Codec used for everything this peer writes. */
  write: MessageCodec;
  /** Codecs this peer accepts on read, tried in order. */
  accept: MessageCodec[];
};

/**
 * Dispatches on byte 0. The formats are self-identifying — a JSON envelope
 * always begins `{`, which is not a token character and so can never begin an
 * HTTP start-line — so no negotiation handshake, magic prefix, or version byte
 * is needed.
 *
 * This is what makes a mixed-version peer pair safe: readers accept either
 * format, so the two ends can be upgraded in any order.
 */
export function newSniffingCodec(options: SniffingCodecOptions): MessageCodec {
  const { write, accept } = options;

  async function pick(input: ByteSource): Promise<{ codec: MessageCodec; input: ByteSource }> {
    const reader = new ByteReader(input);
    const first = await reader.peekByte();
    if (first === undefined) {
      throw new Error("sniff: stream ended before any bytes arrived");
    }
    const codec = accept.find((c) => c.sniff(first));
    if (!codec) {
      throw new Error(
        `sniff: no accepted codec recognises a message starting with byte 0x${first
          .toString(16)
          .padStart(2, "0")}`,
      );
    }
    return { codec, input: reader.rest() };
  }

  return {
    name: `sniff(write=${write.name}; accept=${accept.map((c) => c.name).join(",")})`,
    sniff: (byte) => accept.some((c) => c.sniff(byte)),
    encodeRequest: (env, body) => write.encodeRequest(env, body),
    encodeResponse: (env, body, o) => write.encodeResponse(env, body, o),
    decodeRequest: async (input) => {
      const picked = await pick(input);
      return picked.codec.decodeRequest(picked.input);
    },
    decodeResponse: async (input, o) => {
      const picked = await pick(input);
      return picked.codec.decodeResponse(picked.input, o);
    },
  };
}
