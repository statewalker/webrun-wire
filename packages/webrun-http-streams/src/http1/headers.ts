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

// RFC 3986 `authority` grammar, restricted to `host [ ":" port ]` (no
// userinfo — RFC 9110 §7.2 excludes it from Host). Two shapes: an IP-literal
// in brackets, or a reg-name. Shared by the decoder (validating a Host header
// taken off the wire) and the encoder (validating the authority `splitTarget`
// derives from a caller-supplied url) so the grammar is defined exactly once.
const HOST_IP_LITERAL = /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;
const HOST_REG_NAME = /^[A-Za-z0-9._~-]+(:\d{1,5})?$/;

/**
 * Validates a value that is about to become (or was read as) a `Host`
 * header: untrusted input either way, so an unrecognised shape is a refusal,
 * not a guess. Rejects a present-but-empty value, one carrying userinfo
 * (`evil.com@good.com`), and — the reason this also runs on encode — one
 * smuggling a CRLF-terminated line into the authority of a caller-supplied
 * url. Never applied to trusted configuration (a codec's `opts.host`).
 */
export function assertValidHost(host: string): void {
  if (!HOST_IP_LITERAL.test(host) && !HOST_REG_NAME.test(host)) {
    throw new HttpParseError(`invalid Host header: ${JSON.stringify(host)}`);
  }
}

/**
 * A request-target must be entirely visible ASCII (RFC 9110 VCHAR) — nothing
 * `<= 0x20` (space and every control character, CR/LF included) and nothing
 * `>= 0x7F` (DEL and beyond). Applied on encode (`splitTarget`, so a
 * caller-supplied url can never inject a second request line) and on decode
 * (so a relay that decodes then re-encodes can never put an embedded control
 * character back on the wire).
 */
export function assertValidTarget(target: string): void {
  for (let i = 0; i < target.length; i++) {
    const code = target.charCodeAt(i);
    if (code <= SP || code >= 0x7f) {
      throw new HttpParseError(`invalid request-target: ${JSON.stringify(target)}`);
    }
  }
}

/**
 * Shared control-character check behind both `assertValidHeaderValue` and
 * `assertValidStatusText` — the two were previously checked by different,
 * looser rules (statusText only rejected CR/LF), which is exactly the
 * asymmetry class C1 and M5 are both instances of. `label` is prepended
 * verbatim to each message, so callers keep their own wording.
 */
function assertNoControlChars(label: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0d || code === 0x0a) {
      throw new HttpParseError(`${label} contains CR or LF`);
    }
    if ((code < SP && code !== HTAB) || code === 0x7f) {
      throw new HttpParseError(`${label} contains a control character`);
    }
    if (code > 0xff) {
      throw new HttpParseError(`${label} is not latin-1 encodable`);
    }
  }
}

export function assertValidHeaderValue(name: string, value: string): void {
  assertNoControlChars(`header "${name}" value`, value);
}

/** Same character class as a header value (M5) — CR/LF, every C0 control, and DEL. */
export function assertValidStatusText(value: string): void {
  assertNoControlChars("statusText", value);
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

/**
 * Parse a `Content-Length` field into a single validated value.
 *
 * RFC 9110 §8.6 permits the value to be a comma-separated list of identical
 * numbers (a relay may have appended one), so the list is folded; differing
 * values are a refusal, not a choice. Shared by `resolveFraming` on decode and
 * by the encoder's declared-length check, which previously carried its own
 * copy that did NOT split on commas — so decode accepted `5, 5` while encode
 * rejected it, and a relay that decoded then re-encoded threw.
 *
 * Returns undefined when the field is absent.
 */
export function parseContentLength(values: string[]): number | undefined {
  if (values.length === 0) return undefined;
  const unique = new Set(values.flatMap((v) => v.split(",").map((s) => s.trim())));
  if (unique.size !== 1) {
    throw new HttpParseError(`conflicting Content-Length values: ${[...unique].join(", ")}`);
  }
  const raw = [...unique][0];
  if (!/^\d{1,15}$/.test(raw)) {
    throw new HttpParseError(`invalid Content-Length: ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/**
 * Statuses that carry no body whatever the headers say (RFC 9110 §8.6): 1xx,
 * 204 and 304. Defined once because the encoder must not frame a body for
 * them and the decoder must not try to read one — two lists that agreed today
 * and were free to drift tomorrow.
 *
 * A response to HEAD is also bodyless, but that depends on the request rather
 * than the status, so callers test it separately.
 */
export function isBodylessStatus(status: number): boolean {
  return status < 200 || status === 204 || status === 304;
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

  const length = parseContentLength(cl);
  if (length !== undefined) {
    return { kind: "length", length };
  }

  return { kind: "none" };
}
