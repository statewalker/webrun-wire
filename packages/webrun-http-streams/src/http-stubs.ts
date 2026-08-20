import { fromReadableStream, toReadableStream } from "@statewalker/webrun-streams";
import { discard } from "./bytes.js";
import { collectBytes, supportsRequestStreams } from "./request-streams.js";

export interface SerializedHttpRequest {
  url: string;
  method?: string;
  mode?: RequestMode;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
  integrity?: string;
  keepalive?: boolean;
  headers: Array<[string, string]>;
  [key: string]: unknown;
}

export interface SerializedHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface SerializedHttpEnvelope<Options> {
  options: Options;
  content: AsyncIterable<Uint8Array>;
}

export type HttpHandler = (request: Request) => Response | Promise<Response>;

// Statuses that MUST NOT carry a body — `new Response(body, { status })` throws
// for these (per the Fetch spec's "null body status" set). Exported so
// `fetch.ts` mirrors this exact set rather than redefining it.
export const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const REQUEST_FIELDS = [
  "url",
  "method",
  "mode",
  "credentials",
  "cache",
  "redirect",
  "referrer",
  "referrerPolicy",
  "integrity",
  "keepalive",
] as const;

/** `SerializedHttpEnvelope.content` is never absent, only empty. */
async function* noBytes(): AsyncGenerator<Uint8Array> {}

async function* oneChunk(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

/**
 * Returns an HTTP handler that serializes a Request, hands the envelope to
 * `send` for transport, and deserializes the reply into a Response. Used on
 * the caller side.
 */
export function newHttpClientStub(
  send: (
    envelope: SerializedHttpEnvelope<SerializedHttpRequest>,
  ) => Promise<SerializedHttpEnvelope<SerializedHttpResponse> | undefined>,
): (request: Request | Promise<Request>) => Promise<Response> {
  return async (requestOrPromise) => {
    const request = await requestOrPromise;
    const headers: Array<[string, string]> = [...request.headers].map(([k, v]) => [k, v]);
    const options: SerializedHttpRequest = { url: request.url, headers };
    for (const field of REQUEST_FIELDS) {
      const val = (request as unknown as Record<string, unknown>)[field];
      if (val !== undefined && field !== "url") (options as Record<string, unknown>)[field] = val;
    }
    let content: AsyncIterable<Uint8Array>;
    if (request.body != null) {
      // The streaming path stays first and unconditional: a runtime that has
      // request streams never reaches the fallback, and never buffers an upload.
      content = fromReadableStream(request.body as ReadableStream<Uint8Array>);
    } else if (!supportsRequestStreams()) {
      // Firefox. Without `request.body` there is nothing to stream from, so the
      // only way to see the payload at all is to buffer the whole of it, and
      // request streaming is lost outright on this path — a 1 GiB upload from a
      // Firefox page is a 1 GiB allocation here.
      //
      // The empty-versus-absent body divergence that `fetch.ts` has to live
      // with does not arise on this transport: `SerializedHttpEnvelope` always
      // carries a `content` iterable, so a zero-length body and no body are
      // already the same thing here, whichever runtime produced it.
      content = oneChunk(new Uint8Array(await request.arrayBuffer()));
    } else {
      content = noBytes();
    }

    const result = await send({ options, content });

    if (!result) {
      return new Response(null, { status: 404, statusText: "Error 404: Not Found" });
    }

    const responseOptions = result.options;
    const method = options.method;
    // `new Response(body, ...)` throws for null-body statuses (204/205/304), and
    // HEAD/OPTIONS carry no body either — drain the (empty) content stream and
    // emit a bodyless response. `discard` rather than a bare `.return()`: see
    // the note at the matching site in `newHttpServerStub` below.
    if (
      method === "HEAD" ||
      method === "OPTIONS" ||
      NULL_BODY_STATUSES.has(responseOptions.status)
    ) {
      await discard(result.content);
      return new Response(null, responseOptions);
    }
    return new Response(toReadableStream(result.content[Symbol.asyncIterator]()), responseOptions);
  };
}

/**
 * Returns a server-side transport handler. It deserializes the incoming
 * request envelope, delegates to `handler`, and serializes the response.
 */
export function newHttpServerStub(
  handler: HttpHandler,
): (
  envelope:
    | SerializedHttpEnvelope<SerializedHttpRequest>
    | Promise<SerializedHttpEnvelope<SerializedHttpRequest>>,
) => Promise<SerializedHttpEnvelope<SerializedHttpResponse>> {
  return async (envelopeOrPromise) => {
    const { options, content } = await envelopeOrPromise;
    const { url, method, headers = [], ...rest } = options;
    const { mode: _mode, ...forwardable } = rest as Record<string, unknown>;

    const requestHeaders = new Headers();
    for (const [key, value] of headers) requestHeaders.append(key, value);

    const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const requestInit: RequestInit & { duplex?: "half" } = {
      ...forwardable,
      method,
      headers: requestHeaders,
    };
    if (!hasBody) {
      // `discard`, not a bare `.return()`. GET/HEAD/OPTIONS arrive with a
      // `content` iterable the transport built but nobody has pulled from yet,
      // and `.return()` on an async generator still in *suspended start* is a
      // no-op: the body never runs, its `try/finally` never unwinds, and
      // whatever the producer holds open — a socket, a port subscription — is
      // never released. `discard` calls `.next()` first for exactly this
      // reason; see its comment in `bytes.ts`.
      //
      // `fetch.ts` has the same shape at its null-body-status branch and is
      // *safe* there without this, because the codec has already pulled from
      // that generator to read the response head, so it is never in suspended
      // start. Do not copy the bare form back here on the strength of that one.
      await discard(content);
    } else if (supportsRequestStreams()) {
      requestInit.body = toReadableStream(content[Symbol.asyncIterator]());
      requestInit.duplex = "half";
    } else {
      // Firefox again, and this is the half that fails *silently*. The
      // constructor does not reject a `ReadableStream` here, it stringifies it:
      // the handler would read the literal text `[object ReadableStream]` and
      // answer 200 with corrupt data, where the client direction above at least
      // sends an empty body a JSON endpoint rejects loudly. Bytes it does
      // accept, so drain first — at the same cost as above, the whole upload in
      // memory and no streaming left for the handler.
      requestInit.body = await collectBytes(content);
    }

    const request = new Request(url, requestInit);
    const response = await handler(request);

    const responseOptions: SerializedHttpResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries([...response.headers]),
    };
    const responseContent = response.body
      ? fromReadableStream(response.body as ReadableStream<Uint8Array>)
      : (async function* () {})();
    return { options: responseOptions, content: responseContent };
  };
}
