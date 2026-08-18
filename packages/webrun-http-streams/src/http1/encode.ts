import { discard } from "../bytes.js";
import type { ByteSource, RequestEnvelope, ResponseEnvelope } from "../message.js";
import { encodeChunked } from "./chunked.js";
import { HttpParseError } from "./errors.js";
import {
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
  if (url.startsWith("/")) return { target: url, authority: opts.host };
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^#]*)/.exec(url);
  if (!match) {
    throw new HttpParseError(`cannot derive a request target from url: ${JSON.stringify(url)}`);
  }
  const rawAuthority = match[1];
  if (rawAuthority === "") {
    throw new HttpParseError(`url has no authority: ${JSON.stringify(url)}`);
  }
  // Host is `uri-host [ ":" port ]` — no userinfo (RFC 9110 §7.2). Strip any
  // `user:pass@` prefix so credentials never end up in a header proxies log.
  const at = rawAuthority.lastIndexOf("@");
  const authority = at === -1 ? rawAuthority : rawAuthority.slice(at + 1);

  const rawTarget = match[2];
  const target = rawTarget === "" ? "/" : rawTarget.startsWith("/") ? rawTarget : `/${rawTarget}`;
  return { target, authority };
}

function declaredLength(headers: HeaderList): number | undefined {
  const values = getAll(headers, "content-length");
  if (values.length === 0) return undefined;
  const unique = new Set(values.map((v) => v.trim()));
  if (unique.size !== 1) {
    throw new HttpParseError(`conflicting Content-Length values: ${[...unique].join(", ")}`);
  }
  const raw = [...unique][0];
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

  if (body === undefined) return;
  yield* emitBody(body, declared);
}

export async function* encodeResponse(
  env: ResponseEnvelope,
  body: ByteSource | undefined,
  opts: ResolvedHttpCodecOptions,
  requestMethod?: string,
): AsyncGenerator<Uint8Array> {
  if (!Number.isInteger(env.status) || env.status < 100 || env.status > 599) {
    throw new HttpParseError(`invalid status: ${env.status}`);
  }
  const reason = env.statusText ?? "";
  if (/[\r\n]/.test(reason)) throw new HttpParseError("statusText contains CR or LF");

  const bodyless =
    env.status < 200 || NO_BODY_STATUSES.has(env.status) || requestMethod?.toUpperCase() === "HEAD";

  const carried = withoutHeaders(env.headers, RESPONSE_OWNED);
  const declared = declaredLength(carried);

  let head = `HTTP/1.1 ${env.status} ${reason}\r\n`;
  head += encodeHeaderLines(carried);
  head += "Connection: close\r\n";
  if (!bodyless && body !== undefined && declared === undefined) {
    head += "Transfer-Encoding: chunked\r\n";
  }
  head += "\r\n";
  yield encodeLatin1(head);

  if (bodyless || body === undefined) {
    await discard(bodyless ? body : undefined);
    return;
  }
  yield* emitBody(body, declared);
}
