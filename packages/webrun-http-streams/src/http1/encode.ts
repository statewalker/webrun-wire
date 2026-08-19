import { discard } from "../bytes.js";
import type { ByteSource, RequestEnvelope, ResponseEnvelope } from "../message.js";
import { encodeChunked } from "./chunked.js";
import { HttpParseError } from "./errors.js";
import {
  assertValidHost,
  assertValidStatusText,
  assertValidTarget,
  encodeHeaderLines,
  encodeLatin1,
  getAll,
  type HeaderList,
  isToken,
  withoutHeaders,
} from "./headers.js";

export type ResolvedHttpCodecOptions = {
  scheme: "http" | "https";
  host: string;
  maxHeaderBytes: number;
};

/** Headers the codec owns: a caller-supplied copy is dropped and re-derived. */
const REQUEST_OWNED = ["host", "connection", "transfer-encoding"];
const RESPONSE_OWNED = ["connection", "transfer-encoding"];

const NO_BODY_STATUSES = new Set([204, 304]);

/**
 * Split a URL into an origin-form request target and an authority *without*
 * going through `new URL()`. `URL` normalises percent-encoding and would
 * re-serialise the target — which is the exact class of defect note 15 found
 * in @libp2p/http, where rebuilding the request line silently dropped
 * `url.search`. Here the target is a verbatim slice of the caller's string.
 */
export function splitTarget(
  url: string,
  opts: ResolvedHttpCodecOptions,
): { target: string; authority: string } {
  if (url.startsWith("/")) {
    // Neither field is trusted just because it came from a caller's own url:
    // an unvalidated CRLF here would splice a second request line (or an
    // extra header) onto the wire — see C1.
    assertValidTarget(url);
    return { target: url, authority: opts.host };
  }
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^#]*)/.exec(url);
  if (!match) {
    throw new HttpParseError(`cannot derive a request target from url: ${JSON.stringify(url)}`);
  }
  // Both capture groups are mandatory in the regex above (neither is
  // `?`-quantified), so a successful match always populates them — an empty
  // string is possible, `undefined` is not.
  const rawAuthority = match[1]!;
  if (rawAuthority === "") {
    throw new HttpParseError(`url has no authority: ${JSON.stringify(url)}`);
  }
  // Host is `uri-host [ ":" port ]` — no userinfo (RFC 9110 §7.2). Strip any
  // `user:pass@` prefix so credentials never end up in a header proxies log.
  const at = rawAuthority.lastIndexOf("@");
  const authority = at === -1 ? rawAuthority : rawAuthority.slice(at + 1);
  assertValidHost(authority);

  const rawTarget = match[2]!;
  const target = rawTarget === "" ? "/" : rawTarget.startsWith("/") ? rawTarget : `/${rawTarget}`;
  assertValidTarget(target);
  return { target, authority };
}

function declaredLength(headers: HeaderList): number | undefined {
  const values = getAll(headers, "content-length");
  if (values.length === 0) return undefined;
  const unique = new Set(values.map((v) => v.trim()));
  if (unique.size !== 1) {
    throw new HttpParseError(`conflicting Content-Length values: ${[...unique].join(", ")}`);
  }
  // `unique.size === 1` is checked above, so this spread always has exactly
  // one element.
  const raw = [...unique][0]!;
  if (!/^\d{1,15}$/.test(raw)) {
    throw new HttpParseError(`invalid Content-Length: ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

async function* emitBody(
  body: ByteSource,
  declared: number | undefined,
): AsyncGenerator<Uint8Array> {
  if (declared === undefined) {
    yield* encodeChunked(body);
    return;
  }
  let sent = 0;
  for await (const chunk of body) {
    if (chunk.byteLength === 0) continue;
    sent += chunk.byteLength;
    if (sent > declared) {
      throw new HttpParseError(
        `body exceeds declared Content-Length ${declared} (${sent} bytes so far)`,
      );
    }
    yield chunk;
  }
  if (sent !== declared) {
    throw new HttpParseError(`body is ${sent} bytes but Content-Length declares ${declared}`);
  }
}

export async function* encodeRequest(
  env: RequestEnvelope,
  body: ByteSource | undefined,
  opts: ResolvedHttpCodecOptions,
): AsyncGenerator<Uint8Array> {
  if (!isToken(env.method)) {
    throw new HttpParseError(`invalid method: ${JSON.stringify(env.method)}`);
  }
  const { target, authority } = splitTarget(env.url, opts);
  if (authority === "") {
    throw new HttpParseError("no Host available: url has no authority and no host is configured");
  }

  const carried = withoutHeaders(env.headers, REQUEST_OWNED);
  const declared = declaredLength(carried);

  let head = `${env.method} ${target} HTTP/1.1\r\n`;
  head += `Host: ${authority}\r\n`;
  head += encodeHeaderLines(carried);
  head += "Connection: close\r\n";
  if (body !== undefined && declared === undefined) head += "Transfer-Encoding: chunked\r\n";
  head += "\r\n";
  yield encodeLatin1(head);

  if (body === undefined) {
    // A head promising `declared` bytes with no body at all is a knowingly
    // truncated message — the failure must land here, not on the peer that
    // trusted the header. Content-Length: 0 is the one declared length an
    // absent body actually satisfies. See I1.
    if (declared !== undefined && declared !== 0) {
      throw new HttpParseError(`body is 0 bytes but Content-Length declares ${declared}`);
    }
    return;
  }
  yield* emitBody(body, declared);
}

export async function* encodeResponse(
  env: ResponseEnvelope,
  body: ByteSource | undefined,
  // Unused: response encoding needs no scheme/host/maxHeaderBytes. Kept
  // positionally so this signature mirrors `encodeRequest`'s, which the
  // `newHttpCodec` wrapper in ./index.ts relies on when partially applying
  // `opts` to both.
  _opts: ResolvedHttpCodecOptions,
  requestMethod?: string,
): AsyncGenerator<Uint8Array> {
  if (!Number.isInteger(env.status) || env.status < 100 || env.status > 599) {
    throw new HttpParseError(`invalid status: ${env.status}`);
  }
  const reason = env.statusText ?? "";
  assertValidStatusText(reason);

  // RFC 9110 §8.6: a 1xx or 204 MUST NOT carry Content-Length — there is no
  // body to measure, ever, regardless of what the caller supplied. A
  // response to HEAD is different: no body is sent on *this* response, but
  // the Content-Length describes the body a GET would have sent, so it stays
  // (M4).
  const bodylessStatus = env.status < 200 || NO_BODY_STATUSES.has(env.status);
  const bodyless = bodylessStatus || requestMethod?.toUpperCase() === "HEAD";

  const owned = bodylessStatus ? [...RESPONSE_OWNED, "content-length"] : RESPONSE_OWNED;
  const carried = withoutHeaders(env.headers, owned);
  const declared = declaredLength(carried);

  let head = `HTTP/1.1 ${env.status} ${reason}\r\n`;
  head += encodeHeaderLines(carried);
  head += "Connection: close\r\n";
  if (!bodyless && body !== undefined && declared === undefined) {
    head += "Transfer-Encoding: chunked\r\n";
  }
  head += "\r\n";
  yield encodeLatin1(head);

  if (bodyless) {
    await discard(body);
    return;
  }
  if (body === undefined) {
    // Same truncation guard as encodeRequest — see I1. Not reached when
    // bodyless: a response to HEAD legitimately keeps a declared
    // Content-Length with no body (M4), and that is not a truncation.
    if (declared !== undefined && declared !== 0) {
      throw new HttpParseError(`body is 0 bytes but Content-Length declares ${declared}`);
    }
    return;
  }
  yield* emitBody(body, declared);
}
