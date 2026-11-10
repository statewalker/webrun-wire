import {
  fetchOverDuplex,
  jsonEnvelopeCodec,
  type MessageCodec,
  newHttpCodec,
  newSniffingCodec,
  serveFetchOverDuplex,
} from "@statewalker/webrun-http-streams";
import { connect, overPipe, serve, structuredCodec } from "@statewalker/webrun-rpc";
import { asyncDisposable } from "./async-dispose.js";

/**
 * The version of the HTTP-over-`MessagePort` protocol this package speaks,
 * sent in every hand-shake that sets up a link. Version 1 was this package's
 * own `handleStreams` / `sendStream` (no backpressure); version 2 is
 * webrun-rpc's `connect` / `serve` over `overPipe` with webrun-http-streams'
 * `fetchOverDuplex` / `serveFetchOverDuplex`: one port per link, calls
 * multiplexed on it, each call a stream with backpressure in both
 * directions, and cancellation that reaches the handler. A call's port with a
 * window (`HttpLinkOptions.window`) pipelines its chunks where both ends speak
 * it, and goes one confirmed chunk at a time otherwise, so the window needs
 * no new version.
 */
export const HTTP_LINK_PROTOCOL = "webrun-http-link/2";

export interface HttpLinkOptions {
  /**
   * Per-stream inactivity timeout in ms (webrun-rpc's): a stream with no chunk
   * in either direction for that long fails. Unset — the default — means
   * none: a slow consumer is throttled, never failed.
   */
  streamTimeout?: number;
  /**
   * Ceiling on the requests in flight on the link at once: webrun-rpc's
   * `maxPorts`, one multiplexed port per request (default 1024). A request
   * past it fails on the calling end; one the answering end has no room for is
   * refused. Every exchange gives its port back when it ends, however it ends.
   */
  maxPorts?: number;
  /**
   * The answering end only: once a response is out, how long the request body
   * may go unread before it is abandoned and the exchange ends (default 30 s;
   * webrun-http-streams' `requestIdleMs`). A handler that answers first and
   * reads the upload afterwards keeps it as long as it keeps reading.
   */
  requestIdleMs?: number;
  /**
   * The answering end only: the scheme of the urls its handler sees. A request crosses the link
   * as HTTP/1.1, whose origin-form target (`GET /key/path` and a `Host` header) carries no
   * scheme, so the answering end rebuilds the url with this one. Default: the scheme of this
   * realm's `location` when it is http or https (a page, a Dedicated Worker or a ServiceWorker
   * answers for its own origin), else `http`. Before, it was always `http`: on an https page a
   * handler saw `http://host/…`, and a handler found by its https base url was not found at all.
   */
  scheme?: "http" | "https";
  /**
   * The calling end only: the flow-control window, in bytes, that every
   * request's port asks for (webrun-rpc's `window`; default 256 KiB). On it,
   * request and response bodies are pipelined: chunks leave without waiting
   * for a confirmation each, and a reader that stops holds about one window
   * of them. `0` turns the window off: one confirmed chunk at a time, the
   * envelopes of a link with no window. An answering end of an older version
   * falls back to that by itself.
   */
  window?: number;
}

/** The scheme an answering end rebuilds request urls with: `scheme`, else this realm's. */
function linkScheme(scheme: HttpLinkOptions["scheme"]): "http" | "https" {
  if (scheme) return scheme;
  const protocol = (globalThis as { location?: { protocol?: unknown } }).location?.protocol;
  return protocol === "https:" ? "https" : "http";
}

/** `defaultCodec` (writes HTTP/1.1, reads it or the JSON envelope), decoding urls at `scheme`. */
function linkCodec(scheme: "http" | "https"): MessageCodec | undefined {
  if (scheme === "http") return undefined; // defaultCodec's own
  const http = newHttpCodec({ scheme });
  return newSniffingCodec({ write: http, accept: [http, jsonEnvelopeCodec] });
}

/** The calling end's default `HttpLinkOptions.window`: 256 KiB. */
const DEFAULT_HTTP_LINK_WINDOW = 256 * 1024;

/** The calling end of a link: sends requests, gets responses. */
export interface HttpLink {
  /** Sends `request` and resolves with the response, whose body streams. */
  send(request: Request): Promise<Response>;
  /**
   * Requests whose response has not finished yet: still waiting for the head,
   * or with a body still streaming.
   */
  readonly inflight: number;
  /** Resolves when `inflight` falls to 0. */
  whenIdle(): Promise<void>;
  /**
   * Closes the link. Requests in flight fail with `reason` (default: the link
   * was closed) instead of hanging.
   */
  close(reason?: Error): Promise<void>;
  readonly closed: boolean;
}

/**
 * Why a request failed when its link went away under it: the far side (the
 * handler, or the ServiceWorker) was lost. The request may or may not have
 * been applied.
 */
export class LinkLostError extends Error {
  constructor(message = "The link was lost while this request was in flight") {
    super(`${message}; it may or may not have been applied.`);
    this.name = "LinkLostError";
  }
}

/**
 * Posted on a link's port by the calling end when it closes the link, so the
 * answering end can release it: a `MessagePort` never reports that its other
 * end is gone.
 */
const LINK_CLOSE = "webrun-http:link-close";

/** Opens the calling end of a link on `port` (one port per link). */
export async function connectHttpLink(
  port: MessagePort,
  { streamTimeout, maxPorts, window = DEFAULT_HTTP_LINK_WINDOW }: HttpLinkOptions = {},
): Promise<HttpLink> {
  const { call, close } = await connect({
    mux: overPipe(port, { codec: structuredCodec, side: "initiator", maxPorts, window }),
    timeout: streamTimeout,
  });
  return trackedLink(
    (request) => fetchOverDuplex(call, request),
    async () => {
      try {
        port.postMessage({ type: LINK_CLOSE });
      } catch {}
      await close();
    },
  );
}

/**
 * Serves `handler` on the answering end of a link. Resolves with a teardown
 * that abandons the requests still running (their handlers see the
 * cancellation) and releases the port.
 */
export async function serveHttpLink(
  port: MessagePort,
  handler: (request: Request) => Response | Promise<Response>,
  { streamTimeout, maxPorts, requestIdleMs, scheme }: HttpLinkOptions = {},
): Promise<() => Promise<void>> {
  const codec = linkCodec(linkScheme(scheme));
  const teardown = await serve(
    {
      mux: overPipe(port, { codec: structuredCodec, side: "responder", maxPorts }),
      timeout: streamTimeout,
    },
    serveFetchOverDuplex(async (request) => await handler(request), { requestIdleMs, codec }),
  );
  const onClose = (event: MessageEvent) => {
    if ((event.data as { type?: unknown } | null)?.type === LINK_CLOSE) void close();
  };
  const close = async () => {
    port.removeEventListener("message", onClose);
    await teardown();
  };
  port.addEventListener("message", onClose);
  return close;
}

/**
 * Wraps a `send` so the link knows its requests in flight (for draining and
 * load-based routing) and can fail them all at once when it is closed.
 */
export function trackedLink(
  send: (request: Request) => Promise<Response>,
  release: () => Promise<void> | void,
): HttpLink {
  let inflight = 0;
  let closed = false;
  let lostReason: Error | undefined;
  const failers = new Set<(error: Error) => void>();
  const idleWaiters: Array<() => void> = [];

  const done = () => {
    inflight--;
    if (inflight === 0) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };

  const link: HttpLink = {
    get inflight() {
      return inflight;
    },
    get closed() {
      return closed;
    },
    whenIdle() {
      return inflight === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r));
    },
    async send(request) {
      if (closed) throw lostReason ?? new LinkLostError("The link is closed");
      inflight++;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        failers.delete(fail);
        done();
      };
      let fail: (error: Error) => void = () => {};
      const lost = new Promise<never>((_, reject) => {
        fail = reject;
      });
      failers.add(fail);
      lost.catch(() => {});
      let response: Response;
      try {
        response = await Promise.race([send(request), lost]);
      } catch (error) {
        finish();
        throw lostReason ?? error;
      }
      if (!response.body) {
        finish();
        return response;
      }
      // From here the body fails with the link's reason when the link closes:
      // `fail` becomes the body's, and `finish` removes whichever is current.
      failers.delete(fail);
      const body = guardBody(response.body, finish, request);
      fail = body.fail;
      if (closed) fail(lostReason as Error);
      else if (!finished) failers.add(fail);
      return new Response(body.stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    async close(reason) {
      if (closed) return;
      closed = true;
      lostReason = reason ?? new LinkLostError("The link was closed");
      for (const fail of [...failers]) fail(lostReason);
      try {
        await release();
      } catch {}
    },
  };
  // `await using link = await connectHttpLink(port)` closes it at the end of the block.
  return asyncDisposable(link, () => link.close());
}

/**
 * A response body that reports its end (done, cancelled, failed or aborted).
 * `fail(error)` ends it with `error` at once — the link calls it when it is lost
 * mid-stream. An abort of the request's signal does the same with the signal's
 * reason, read or not: the exchange is over (the layer below has given its port
 * back), so the request leaves `inflight` then. A read waits on the reader
 * alone, so nothing outlives the chunk it brings.
 */
function guardBody(
  body: ReadableStream<Uint8Array>,
  finish: () => void,
  request: Request,
): { stream: ReadableStream<Uint8Array>; fail: (error: Error) => void } {
  // Held until the body ends: the Request's signal follows the caller's signal only while the
  // Request lives (Node's undici holds the Request's controller through a WeakRef), and a caller may keep only the Response.
  const keep: { request?: Request } = { request };
  const signal: AbortSignal | undefined = request.signal ?? undefined;
  const reader = body.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const end = () => {
    ended = true;
    signal?.removeEventListener("abort", onAbort);
    keep.request = undefined;
    finish();
  };
  const fail = (error: Error) => {
    if (ended) return;
    end();
    void reader.cancel().catch(() => {});
    try {
      controller.error(error);
    } catch {
      /* already closed or errored */
    }
  };
  const onAbort = () => fail(abortError(signal as AbortSignal));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (done) {
          end();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        fail(error as Error);
      }
    },
    cancel(why) {
      end();
      // The body is cancelled a macrotask later, not at once. Between two of its pulls it has
      // no read in flight (the stream holds the next `pull` until the last one settles, for a
      // few microtasks), and a cancel landing there abandons the call even with its end on the
      // way. A macrotask later it has either closed (its end came: the call is finished, and
      // an upload the handler reads after answering goes on) or started its next read, which
      // then decides as `fetchOverDuplex`'s body does. How many microtasks the gap lasts
      // differs between engines (Node 22 and 24 do). `cancel()` does not wait for it.
      setTimeout(() => void reader.cancel(why).catch(() => {}), 0);
    },
  });
  return { stream, fail };
}

/** The signal's reason as an `Error` (`AbortError` when it gave none). */
function abortError(signal: AbortSignal): Error {
  const why = (signal as unknown as { reason?: unknown }).reason;
  if (why instanceof Error) return why;
  const err = new Error(why === undefined ? "Aborted" : String(why));
  err.name = "AbortError";
  return err;
}
