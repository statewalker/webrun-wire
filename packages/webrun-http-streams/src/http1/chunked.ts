import type { ByteReader } from "../bytes.js";
import { ByteStreamError } from "../bytes.js";
import type { ByteSource } from "../message.js";
import { HttpParseError } from "./errors.js";
import { decodeLatin1 } from "./headers.js";

const CRLF = new Uint8Array([0x0d, 0x0a]);
const LAST_CHUNK = new Uint8Array([0x30, 0x0d, 0x0a, 0x0d, 0x0a]); // "0\r\n\r\n"
const encoder = new TextEncoder();

/**
 * Chunk sizes are written in HEXADECIMAL — a 21-byte chunk is `15`. Writing
 * them in decimal is the defect note 15 found in @libp2p/http, and it is the
 * one that cannot be caught downstream: decimal digits are also valid hex, so
 * a conforming parser silently reads the wrong length.
 *
 * Zero-length source chunks are skipped; a zero-sized chunk on the wire is the
 * body terminator.
 */
export async function* encodeChunked(body: ByteSource): AsyncGenerator<Uint8Array> {
  for await (const chunk of body) {
    if (chunk.byteLength === 0) continue;
    yield encoder.encode(`${chunk.byteLength.toString(16)}\r\n`);
    yield chunk;
    yield CRLF;
  }
  yield LAST_CHUNK;
}

/**
 * Decode a chunked body, yielding data chunks as they arrive. Nothing is
 * accumulated: a chunk larger than the transport's frame is yielded in pieces.
 */
export async function* decodeChunked(
  reader: ByteReader,
  maxLineBytes: number,
): AsyncGenerator<Uint8Array> {
  while (true) {
    const sizeLine = decodeLatin1(await reader.readLine(maxLineBytes));
    const semicolon = sizeLine.indexOf(";"); // chunk extensions: accepted, ignored
    const sizeText = semicolon === -1 ? sizeLine : sizeLine.slice(0, semicolon);
    if (!/^[0-9a-fA-F]{1,13}$/.test(sizeText)) {
      throw new HttpParseError(`invalid chunk size: ${JSON.stringify(sizeLine)}`);
    }
    const size = Number.parseInt(sizeText, 16);

    if (size === 0) {
      // Trailer section: legal input, read and discarded, never re-emitted.
      let used = 0;
      while (true) {
        const remaining = maxLineBytes - used;
        if (remaining <= 0) {
          throw new HttpParseError(`trailer section exceeds ${maxLineBytes} bytes`);
        }
        const lineBytes = await reader.readLine(remaining);
        used += lineBytes.byteLength + 2;
        if (lineBytes.byteLength === 0) break;
      }
      return;
    }

    let remaining = size;
    while (remaining > 0) {
      const part = await reader.readSome(remaining);
      if (part === undefined) {
        throw new HttpParseError(`chunk truncated: ${remaining} of ${size} bytes missing`);
      }
      remaining -= part.byteLength;
      yield part;
    }

    try {
      if ((await reader.readLine(2)).byteLength !== 0) {
        throw new HttpParseError("chunk data not terminated by CRLF");
      }
    } catch (err) {
      if (err instanceof ByteStreamError) {
        throw new HttpParseError("chunk data not terminated by CRLF");
      }
      throw err;
    }
  }
}
