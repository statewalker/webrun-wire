import type { Duplex } from "@statewalker/webrun-streams";
import { asyncDisposable } from "./async-dispose.js";
import type { RequestEnvelope, ResponseEnvelope } from "./envelope.js";
import { abortReason, type HttpDataOptions, httpFetch, httpServe } from "./http-data.js";
import { NULL_BODY_STATUSES } from "./http-stubs.js";
import type { ByteSource } from "./message.js";
import { collectBytes, supportsRequestStreams } from "./request-streams.js";

/**
 * Connection-scoped headers. The codec surfaces them verbatim (decision 12),
 * but they are meaningless to a `Request`/`Response`, and re-emitting them
 * from a relay would corrupt its framing.
 */
const HOP_BY_HOP = /* @__PURE__ */ new Set([
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
  const {
    envelope,
    body: respBody,
    release,
    finish,
  } = await httpFetch(call, env, body, {
    ...options,
    signal: request.signal ?? undefined,
  });
  const responseInit: ResponseInit = {
    status: envelope.status,
    statusText: envelope.statusText,
    headers: forwardableHeaders(envelope.headers),
  };
  // `new Response(body, { status })` throws for the null-body-status set, and
  // HEAD/OPTIONS carry no body either, so return a bodyless Response. The
  // caller has taken it in full: the call is finished as for any body read to
  // its end — not abandoned, which would cut off an upload the handler is
  // still reading.
  if (
    request.method === "HEAD" ||
    request.method === "OPTIONS" ||
    NULL_BODY_STATUSES.has(envelope.status)
  ) {
    if (finish) finish();
    else await release?.();
    return new Response(null, responseInit);
  }
  return new Response(responseBody(respBody, request, release), responseInit);
}

/**
 * Wrap a `(Request) => Promise<Response>` handler as a `Duplex` so it can be
 * registered with any `webrun-streams-*` adapter's `serve`.
 */
export function serveFetchOverDuplex(
  handler: (request: Request) => Promise<Response>,
  options: HttpDataOptions = {},
): Duplex {
  return httpServe(async (env, body, exchange) => {
    const reqInit: RequestInit = {
      method: env.method,
      headers: forwardableHeaders(env.headers),
      // Aborts when the caller abandons the exchange (see `HttpExchange`).
      signal: exchange?.signal,
    };
    let upload: ReturnType<typeof trackingEnd> | undefined;
    if (env.method !== "GET" && env.method !== "HEAD") {
      if (supportsRequestStreams()) {
        upload = trackingEnd(body);
        reqInit.body = asyncIterableToReadable(upload.source);
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
    // Once the response is out, the exchange ends when the handler is done
    // with the request body too: a handler may answer first and read the
    // upload afterwards (`202`, then store it). One it never took — not used,
    // not locked — it will not read: cancel it, and the exchange ends now. One
    // it took and stopped reading (a reader dropped, a clone nobody reads) is
    // abandoned once nothing has asked it for a chunk for `requestIdleMs`.
    const settled = async () => {
      if (!upload) return;
      if (!request.bodyUsed && !request.body?.locked) {
        // Not awaited: the cancel of one branch of a tee (`request.clone()`)
        // settles only once the other branch is cancelled too, and a clone
        // nobody reads never is. The idle bound below ends that one.
        void request.body?.cancel().catch(() => {});
      }
      await upload.settle(options.requestIdleMs ?? DEFAULT_REQUEST_IDLE_MS);
    };
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
      return { envelope: respEnv, body: undefined, settled };
    }
    return {
      envelope: respEnv,
      body: response.body ? readableToAsyncIterable(response.body) : undefined,
      // A body the codec never started reading has no reader to cancel
      // through; cancel the stream itself. Once read, it is locked and this
      // rejects, harmlessly: the reader's own cancellation has run.
      release: () => response.body?.cancel(),
      settled,
    };
  }, options);
}

/** How long a request body may sit unread after the response before it is abandoned. */
export const DEFAULT_REQUEST_IDLE_MS = 30_000;

/**
 * `source`, and `settle(idleMs)`: resolves once it is done — read to its end,
 * failed, or abandoned (`return()` included before the first `next()`, which a
 * generator's `finally` would not see) — or once nobody has asked it for a
 * chunk for `idleMs`, in which case it is abandoned: later reads fail.
 *
 * Idle counts only while no `next()` is pending: a reader waiting for a slow
 * sender is still reading.
 */
function trackingEnd(source: AsyncIterable<Uint8Array>): {
  source: AsyncIterable<Uint8Array>;
  settle(idleMs: number): Promise<void>;
} {
  let end: () => void = () => {};
  let isEnded = false;
  const ended = new Promise<void>((resolve) => {
    end = () => {
      isEnded = true;
      resolve();
    };
  });
  let abandoned: Error | undefined;
  let pending = 0;
  let idleSince = Date.now();
  const it = source[Symbol.asyncIterator]();
  const abandon = (reason: Error) => {
    abandoned ??= reason;
    end();
    void Promise.resolve(it.return?.(undefined)).catch(() => {});
  };
  const tracked: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return tracked;
    },
    async next() {
      if (abandoned) throw abandoned;
      pending++;
      try {
        const r = await it.next();
        if (r.done) end();
        return r;
      } catch (error) {
        end();
        throw error;
      } finally {
        if (--pending === 0) idleSince = Date.now();
      }
    },
    async return(value?: unknown) {
      end();
      try {
        await it.return?.(value);
      } catch {
        /* abandoned either way */
      }
      return { done: true, value: undefined };
    },
  };
  asyncDisposable(tracked, () => tracked.return?.() ?? Promise.resolve());
  const settle = (idleMs: number): Promise<void> => {
    if (isEnded || !Number.isFinite(idleMs)) return ended;
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        if (isEnded) return resolve();
        const idle = pending === 0 ? Date.now() - idleSince : 0;
        if (idle >= idleMs) {
          abandon(
            new Error(
              `webrun-http-streams: the request body was left unread for ${idleMs} ms after the response; abandoned`,
            ),
          );
          return resolve();
        }
        timer = setTimeout(check, Math.max(1, Math.min(idleMs - idle, 1_000)));
        (timer as { unref?: () => void }).unref?.();
      };
      void ended.then(() => {
        clearTimeout(timer);
        resolve();
      });
      check();
    });
  };
  return { source: tracked, settle };
}

/**
 * How long a cancelled body waits for the read in flight before it abandons the call anyway.
 * The read's answer tells a body that has ended (the call is finished: an upload the handler
 * reads after answering goes on) from one that has not; a peer that sends nothing more never
 * answers it. A body whose end comes later than this after the cancel is abandoned too, so a
 * handler still streaming its response and still reading the upload then loses the upload.
 */
const CANCEL_GRACE_MS = 1_000;

/**
 * The response body as a stream that the request's signal can end at any time.
 *
 * An abort errors the stream with the abort's reason at once — a read waiting
 * for a peer that sends nothing more rejects then, not when a next chunk
 * arrives, which may be never — and abandons the call (`release`), so on a
 * multiplexed transport its port is given back whether or not anyone still
 * reads the body. The listener is removed once the body ends, however it ends:
 * read to its end, cancelled, failed or aborted. A body nobody reads or cancels
 * keeps it until the signal aborts (and keeps the call open until then anyway).
 * A cancel abandons the call too — unless the read in flight comes back with the
 * body's end, which finishes it instead (see `cancel`).
 */
function responseBody(
  body: AsyncIterable<Uint8Array>,
  request: Request,
  release: (() => Promise<void>) | undefined,
): ReadableStream<Uint8Array> {
  // The body holds its Request until it ends. A Request's signal follows the caller's signal
  // only while the Request lives (the platform links them weakly): once a caller that keeps
  // only the Response lets the Request go, an abort would never reach this body.
  const keep: { request?: Request } = { request };
  const signal: AbortSignal | undefined = request.signal ?? undefined;
  const it = body[Symbol.asyncIterator]();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let reading = false;
  const end = () => {
    ended = true;
    signal?.removeEventListener("abort", onAbort);
    keep.request = undefined;
  };
  const onAbort = () => {
    if (ended) return;
    end();
    try {
      controller.error(abortReason(signal as AbortSignal));
    } catch {
      /* already closed or errored */
    }
    void release?.();
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(c) {
      try {
        reading = true;
        const { done, value } = await it.next().finally(() => {
          reading = false;
        });
        if (ended) return; // aborted or cancelled while this read waited
        if (done) {
          end();
          c.close();
          return;
        }
        c.enqueue(value);
      } catch (err) {
        if (ended) return;
        end();
        c.error(err);
      }
    },
    cancel() {
      end();
      const returned = Promise.resolve(it.return?.()).catch(() => {});
      if (!reading) return; // `it` is at rest: its return abandons the call (releasingOnExit)
      // A read is in flight, and `it.return()` is queued behind it: that read's answer decides.
      // The body's end → the call is finished, not abandoned, so an upload the handler reads
      // after answering goes on; a chunk → the return then abandons the call. A peer that never
      // answers (sends nothing more, for good) would hold the call forever: abandon it after a
      // grace, without waiting in `cancel()` either way.
      const grace = setTimeout(() => void release?.(), CANCEL_GRACE_MS);
      (grace as { unref?: () => void }).unref?.();
      void returned.finally(() => clearTimeout(grace));
    },
  });
}
