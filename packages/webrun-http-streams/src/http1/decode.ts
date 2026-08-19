import { ByteReader, ByteStreamError } from "../bytes.js";
import type { ByteSource, DecodedRequest, DecodedResponse } from "../message.js";
import { decodeChunked } from "./chunked.js";
import type { ResolvedHttpCodecOptions } from "./encode.js";
import { HttpParseError } from "./errors.js";
import {
  assertValidHost,
  assertValidTarget,
  type BodyFraming,
  decodeLatin1,
  getAll,
  isBodylessStatus,
  isToken,
  readHeaderSection,
  resolveFraming,
} from "./headers.js";

const VERSIONS = new Set(["HTTP/1.1", "HTTP/1.0"]);
const ABSOLUTE_FORM = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * One message per Duplex call (ADR-0006), so bytes after a complete message
 * are an error. Checked against what is ALREADY BUFFERED rather than by
 * awaiting end-of-stream: a live socket from a keep-alive peer never reaches
 * EOF, so awaiting one would hang instead of failing.
 */
function assertNoBufferedBytes(reader: ByteReader): void {
  const extra = reader.bufferedLength();
  if (extra > 0) {
    throw new HttpParseError(`${extra} trailing bytes after a complete message`);
  }
}

/**
 * The public error contract (I2): everything leaving `decodeRequest` /
 * `decodeResponse` is an `HttpParseError`, whether the refusal happened
 * synchronously (a malformed start line or header) or lazily while the body
 * is later drained. `ByteStreamError` — the `ByteReader`'s own class, never
 * exported — is the one thing converted here, message and all preserved via
 * `cause`. Anything else is a genuine failure of the underlying source (a
 * dropped socket, say) and must reach the caller unchanged: blanket-catching
 * would hide that distinction.
 */
function toHttpParseError(err: unknown): never {
  if (err instanceof ByteStreamError) {
    throw new HttpParseError(err.message, { cause: err });
  }
  throw err;
}

/** Applies `toHttpParseError` across the whole lifetime of a body generator. */
async function* convertBodyErrors(source: AsyncGenerator<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    yield* source;
  } catch (err) {
    toHttpParseError(err);
  }
}

async function* readBody(
  reader: ByteReader,
  framing: BodyFraming,
  opts: ResolvedHttpCodecOptions,
  noneMeansEof: boolean,
): AsyncGenerator<Uint8Array> {
  if (framing.kind === "chunked") {
    yield* decodeChunked(reader, opts.maxHeaderBytes);
    assertNoBufferedBytes(reader);
    return;
  }
  if (framing.kind === "length") {
    let remaining = framing.length;
    while (remaining > 0) {
      const part = await reader.readSome(remaining);
      if (part === undefined) {
        throw new HttpParseError(`body truncated: ${remaining} of ${framing.length} bytes missing`);
      }
      remaining -= part.byteLength;
      yield part;
    }
    assertNoBufferedBytes(reader);
    return;
  }
  if (noneMeansEof) {
    yield* reader.rest();
    return;
  }
  assertNoBufferedBytes(reader);
}

/**
 * `readLine`'s bound is best-effort — it is skipped when the line is already
 * buffered — so a very long start line can reach these messages intact. Since
 * a refusal is now echoed back to the sender in a 400 body, quote only enough
 * to diagnose rather than reflecting the whole thing.
 */
function quoteLine(line: string): string {
  const MAX = 120;
  return line.length <= MAX
    ? JSON.stringify(line)
    : `${JSON.stringify(line.slice(0, MAX))} (truncated from ${line.length} chars)`;
}

export async function decodeRequest(
  input: ByteSource,
  opts: ResolvedHttpCodecOptions,
): Promise<DecodedRequest> {
  const reader = new ByteReader(input);
  try {
    const startBytes = await reader.readLine(opts.maxHeaderBytes);
    const startLine = decodeLatin1(startBytes);
    const parts = startLine.split(" ");
    if (parts.length !== 3) {
      throw new HttpParseError(`malformed request line: ${quoteLine(startLine)}`);
    }
    const [method, target, version] = parts;
    if (!isToken(method)) throw new HttpParseError(`invalid method: ${JSON.stringify(method)}`);
    if (!VERSIONS.has(version)) {
      throw new HttpParseError(`unsupported HTTP version: ${JSON.stringify(version)}`);
    }
    if (target === "*") {
      throw new HttpParseError("asterisk-form request target is not supported");
    }
    // A relay that decodes then re-encodes must never be able to put a
    // control character (a raw CR chief among them) back onto a request
    // line — see C1.
    assertValidTarget(target);

    const headers = await readHeaderSection(reader, opts.maxHeaderBytes, startBytes.byteLength + 2);

    const hosts = getAll(headers, "host");
    if (hosts.length > 1) throw new HttpParseError("multiple Host headers");
    const host = hosts[0];

    let url: string;
    if (target.startsWith("/")) {
      if (version === "HTTP/1.1" && host === undefined) {
        throw new HttpParseError("HTTP/1.1 request has no Host header");
      }
      if (host !== undefined) assertValidHost(host);
      // The scheme is not on the wire in origin-form; it comes from config.
      url = `${opts.scheme}://${host ?? opts.host}${target}`;
    } else if (ABSOLUTE_FORM.test(target)) {
      url = target;
    } else {
      throw new HttpParseError(`unsupported request target: ${JSON.stringify(target)}`);
    }

    // `Host` grammar alone is not sufficient proof that the assembled url is
    // sane — this is a fail-safe belt-and-braces check, not a
    // re-serialisation: the parsed `URL` is discarded, and `url` itself is
    // what reaches the envelope untouched.
    try {
      new URL(url);
    } catch {
      throw new HttpParseError(`decoded url is not a valid URL: ${JSON.stringify(url)}`);
    }

    return {
      envelope: { url, method, headers },
      body: convertBodyErrors(readBody(reader, resolveFraming(headers, version), opts, false)),
    };
  } catch (err) {
    toHttpParseError(err);
  }
}

export async function decodeResponse(
  input: ByteSource,
  opts: ResolvedHttpCodecOptions,
  method: string,
): Promise<DecodedResponse> {
  const reader = new ByteReader(input);
  try {
    const startBytes = await reader.readLine(opts.maxHeaderBytes);
    const startLine = decodeLatin1(startBytes);

    const firstSp = startLine.indexOf(" ");
    if (firstSp === -1) {
      throw new HttpParseError(`malformed status line: ${quoteLine(startLine)}`);
    }
    const version = startLine.slice(0, firstSp);
    if (!VERSIONS.has(version)) {
      throw new HttpParseError(`unsupported HTTP version: ${JSON.stringify(version)}`);
    }
    const afterVersion = startLine.slice(firstSp + 1);
    const secondSp = afterVersion.indexOf(" ");
    const codeText = secondSp === -1 ? afterVersion : afterVersion.slice(0, secondSp);
    if (!/^\d{3}$/.test(codeText)) {
      throw new HttpParseError(`invalid status code: ${JSON.stringify(codeText)}`);
    }
    const status = Number(codeText);
    const statusText = secondSp === -1 ? "" : afterVersion.slice(secondSp + 1);

    const headers = await readHeaderSection(reader, opts.maxHeaderBytes, startBytes.byteLength + 2);

    const bodyless = isBodylessStatus(status) || method.toUpperCase() === "HEAD";
    const framing: BodyFraming = bodyless ? { kind: "none" } : resolveFraming(headers, version);

    return {
      envelope: { status, statusText, headers },
      body: convertBodyErrors(readBody(reader, framing, opts, !bodyless)),
    };
  } catch (err) {
    toHttpParseError(err);
  }
}
