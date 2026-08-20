import type { Duplex } from "@statewalker/webrun-streams";
import type { RequestEnvelope, ResponseEnvelope } from "./envelope.js";
import { type HttpDataOptions, httpFetch, httpServe } from "./http-data.js";
import { NULL_BODY_STATUSES } from "./http-stubs.js";
import type { ByteSource } from "./message.js";
import { collectBytes, supportsRequestStreams } from "./request-streams.js";

/**
 * Connection-scoped headers. The codec surfaces them verbatim (decision 12),
 * but they are meaningless to a `Request`/`Response`, and re-emitting them
 * from a relay would corrupt its framing.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardableHeaders(headers: [string, string][]): [string, string][] {
  return headers.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()));
}

function headersToArray(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((value, key) => {
    out.push([key, value]);
  });
  return out;
}

async function* readableToAsyncIterable(
  stream: ReadableStream<Uint8Array> | null | undefined,
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  let consumed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        consumed = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    if (!consumed) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function asyncIterableToReadable(iter: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = iter[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await it.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/**
 * Run a `Request` through a `Duplex` call and reconstruct the `Response` on
 * the other side. The request's `signal` is plumbed into the body iteration —
 * abort terminates the underlying call.
 */
export async function fetchOverDuplex(
  call: Duplex,
  request: Request,
  options: HttpDataOptions = {},
): Promise<Response> {
  if (request.signal?.aborted) throw abortReason(request.signal);
  const env: RequestEnvelope = {
    url: request.url,
    method: request.method,
    headers: headersToArray(request.headers),
  };
  let body: ByteSource | undefined;
  if (request.body != null) {
    // The streaming path stays first and unconditional: a runtime that has
    // request streams never reaches the fallback, and never buffers an upload.
    body = readableToAsyncIterable(request.body);
  } else if (!supportsRequestStreams()) {
    // Firefox. Without `request.body` there is nothing to stream from, so the
    // only way to see the payload at all is to buffer the whole of it. Two
    // consequences, both real, neither worth rediscovering:
    //
    //  1. Request streaming is lost outright on this path. A 1 GiB upload from
    //     a Firefox page is a 1 GiB allocation here, where Chromium would have
    //     streamed it chunk by chunk.
    //  2. Buffering cannot distinguish an absent body from an empty one.
    //     Chromium's `new Request(url, { method: "POST", body: "" })` yields a
    //     non-null empty stream, so an empty body envelope goes on the wire
    //     (with the HTTP/1.1 codec, a chunked body whose only chunk is the
    //     terminator); here a zero-length `arrayBuffer()` is indistinguishable
    //     from no body and we send none. Both decode to the same empty body at
    //     the far end — `kind: "none"` framing on a request means zero bytes,
    //     not read-to-EOF — so only the framing differs, but it does differ.
    const buffered = new Uint8Array(await request.arrayBuffer());
    if (buffered.byteLength > 0) body = [buffered];
  }
  const { envelope, body: respBody } = await httpFetch(call, env, body, options);
  const responseInit: ResponseInit = {
    status: envelope.status,
    statusText: envelope.statusText,
    headers: forwardableHeaders(envelope.headers),
  };
  // `new Response(body, { status })` throws for the null-body-status set, and
  // HEAD/OPTIONS carry no body either — drain the abandoned body stream
  // before returning a bodyless Response. Mirrors `http-stubs.ts`'s client
  // stub; skipping the drain would abandon the body iterator mid-stream,
  // which over a `Duplex` can leave the stream unterminated or leak the
  // producer.
  if (
    request.method === "HEAD" ||
    request.method === "OPTIONS" ||
    NULL_BODY_STATUSES.has(envelope.status)
  ) {
    const returnable = respBody as AsyncIterable<Uint8Array> & { return?: () => unknown };
    await returnable.return?.();
    return new Response(null, responseInit);
  }
  return new Response(asyncIterableToReadable(withAbort(respBody, request.signal)), responseInit);
}

/**
 * Wrap a `(Request) => Promise<Response>` handler as a `Duplex` so it can be
 * registered with any `webrun-streams-*` adapter's `serve`.
 */
export function serveFetchOverDuplex(
  handler: (request: Request) => Promise<Response>,
  options: HttpDataOptions = {},
): Duplex {
  return httpServe(async (env, body) => {
    const reqInit: RequestInit = {
      method: env.method,
      headers: forwardableHeaders(env.headers),
    };
    if (env.method !== "GET" && env.method !== "HEAD") {
      if (supportsRequestStreams()) {
        reqInit.body = asyncIterableToReadable(body);
        (reqInit as RequestInit & { duplex?: string }).duplex = "half";
      } else {
        // Firefox again, and this is the half that fails *silently*. The
        // constructor does not reject a `ReadableStream` here, it stringifies
        // it: the handler would read the literal text `[object ReadableStream]`
        // and answer 200 with corrupt data, where the outbound direction at
        // least fails loudly with a 500. Bytes it does accept, so drain first.
        //
        // Same cost as the outbound fallback: the whole upload is held in
        // memory, and a handler that wanted to stream its request body cannot.
        // Unlike outbound, an empty body is still passed through — the
        // streaming branch above always sets `body` for these methods, and
        // passing a zero-length `Uint8Array` keeps that true.
        reqInit.body = await collectBytes(body);
      }
    }
    const request = new Request(env.url, reqInit);
    const response = await handler(request);
    const respEnv: ResponseEnvelope = {
      status: response.status,
      statusText: response.statusText,
      headers: headersToArray(response.headers),
    };
    // Mirror the client direction: put no bytes on the wire for a
    // null-body-status response or a HEAD/OPTIONS request, even if the
    // handler's Response carries a body stream. Cancel it so the producer
    // isn't left hanging.
    if (
      env.method === "HEAD" ||
      env.method === "OPTIONS" ||
      NULL_BODY_STATUSES.has(response.status)
    ) {
      await response.body?.cancel();
      return { envelope: respEnv, body: undefined };
    }
    return {
      envelope: respEnv,
      body: response.body ? readableToAsyncIterable(response.body) : undefined,
    };
  }, options);
}

async function* withAbort(
  iter: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  if (!signal) {
    yield* iter;
    return;
  }
  for await (const chunk of iter) {
    if (signal.aborted) throw abortReason(signal);
    yield chunk;
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as unknown as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined ? "Aborted" : String(reason));
  err.name = "AbortError";
  return err;
}
