import type { ByteReader } from "../bytes.js";
import { HttpParseError } from "./errors.js";

export type HeaderList = [string, string][];

const TCHAR = new Set(
  "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
);

const SP = 0x20;
const HTAB = 0x09;

export function isTokenChar(byte: number): boolean {
  return byte > SP && byte < 0x7f && TCHAR.has(String.fromCharCode(byte));
}

export function isToken(value: string): boolean {
  if (value.length === 0) return false;
  for (const ch of value) {
    if (!TCHAR.has(ch)) return false;
  }
  return true;
}

/**
 * Header bytes are latin-1: byte-preserving, matching Node, and lossless
 * across a decode/encode round-trip. Control characters are rejected
 * separately by `assertValidHeaderValue`.
 */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new HttpParseError(`not latin-1 encodable: ${JSON.stringify(text)}`);
    }
    out[i] = code;
  }
  return out;
}

export function assertValidHeaderValue(name: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0d || code === 0x0a) {
      throw new HttpParseError(`header "${name}" value contains CR or LF`);
    }
    if ((code < SP && code !== HTAB) || code === 0x7f) {
      throw new HttpParseError(`header "${name}" value contains a control character`);
    }
    if (code > 0xff) {
      throw new HttpParseError(`header "${name}" value is not latin-1 encodable`);
    }
  }
}

export function encodeHeaderLines(headers: HeaderList): string {
  let out = "";
  for (const [name, value] of headers) {
    if (!isToken(name)) throw new HttpParseError(`invalid header name: ${JSON.stringify(name)}`);
    assertValidHeaderValue(name, value);
    out += `${name}: ${value}\r\n`;
  }
  return out;
}

/**
 * Read to the blank line. `alreadyUsed` is the byte count of the start line,
 * so the bound covers the whole head section rather than the headers alone.
 */
export async function readHeaderSection(
  reader: ByteReader,
  maxHeaderBytes: number,
  alreadyUsed: number,
): Promise<HeaderList> {
  const headers: HeaderList = [];
  let used = alreadyUsed;
  while (true) {
    const remaining = maxHeaderBytes - used;
    if (remaining <= 0) {
      throw new HttpParseError(`head section exceeds ${maxHeaderBytes} bytes`);
    }
    const lineBytes = await reader.readLine(remaining);
    used += lineBytes.byteLength + 2;
    if (used > maxHeaderBytes) {
      throw new HttpParseError(`head section exceeds ${maxHeaderBytes} bytes`);
    }
    if (lineBytes.byteLength === 0) return headers;
    if (lineBytes[0] === SP || lineBytes[0] === HTAB) {
      throw new HttpParseError("obs-fold header continuation is not accepted");
    }
    const line = decodeLatin1(lineBytes);
    const colon = line.indexOf(":");
    if (colon <= 0) throw new HttpParseError(`malformed header line: ${JSON.stringify(line)}`);
    const name = line.slice(0, colon);
    if (!isToken(name)) throw new HttpParseError(`invalid header name: ${JSON.stringify(name)}`);
    const value = line
      .slice(colon + 1)
      .replace(/^[ \t]+/, "")
      .replace(/[ \t]+$/, "");
    assertValidHeaderValue(name, value);
    headers.push([name, value]);
  }
}

export function getAll(headers: HeaderList, name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v);
}

export function withoutHeaders(headers: HeaderList, names: string[]): HeaderList {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return headers.filter(([k]) => !drop.has(k.toLowerCase()));
}

export type BodyFraming =
  | { kind: "chunked" }
  | { kind: "length"; length: number }
  | { kind: "none" };

/**
 * RFC 9112 §6.3, with every ambiguity turned into a refusal. In particular a
 * message declaring both Content-Length and Transfer-Encoding is rejected
 * rather than resolved — disagreeing on which one wins is request smuggling.
 */
export function resolveFraming(headers: HeaderList, version: string): BodyFraming {
  const te = getAll(headers, "transfer-encoding");
  const cl = getAll(headers, "content-length");

  if (te.length > 0 && cl.length > 0) {
    throw new HttpParseError(
      "message declares both Content-Length and Transfer-Encoding; refusing (request smuggling)",
    );
  }

  if (te.length > 0) {
    const encodings = te
      .join(",")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== "");
    if (encodings.length !== 1 || encodings[0] !== "chunked") {
      throw new HttpParseError(`unsupported Transfer-Encoding: ${JSON.stringify(te.join(", "))}`);
    }
    if (version === "HTTP/1.0") {
      throw new HttpParseError("Transfer-Encoding is not valid in HTTP/1.0");
    }
    return { kind: "chunked" };
  }

  if (cl.length > 0) {
    const values = new Set(cl.flatMap((v) => v.split(",").map((s) => s.trim())));
    if (values.size !== 1) {
      throw new HttpParseError(`conflicting Content-Length values: ${[...values].join(", ")}`);
    }
    const raw = [...values][0];
    if (!/^\d{1,15}$/.test(raw)) {
      throw new HttpParseError(`invalid Content-Length: ${JSON.stringify(raw)}`);
    }
    return { kind: "length", length: Number(raw) };
  }

  return { kind: "none" };
}
