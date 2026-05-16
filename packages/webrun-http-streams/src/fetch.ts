import type { Duplex } from "@statewalker/webrun-streams";
import type { RequestEnvelope, ResponseEnvelope } from "./envelope.js";
import { httpFetch, httpServe } from "./http-data.js";

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
export async function fetchOverDuplex(call: Duplex, request: Request): Promise<Response> {
  if (request.signal?.aborted) throw abortReason(request.signal);
  const env: RequestEnvelope = {
    url: request.url,
    method: request.method,
    headers: headersToArray(request.headers),
  };
  const body = request.body ? readableToAsyncIterable(request.body) : undefined;
  const { envelope, body: respBody } = await httpFetch(call, env, body);
  return new Response(asyncIterableToReadable(withAbort(respBody, request.signal)), {
    status: envelope.status,
    statusText: envelope.statusText,
    headers: envelope.headers,
  });
}

/**
 * Wrap a `(Request) => Promise<Response>` handler as a `Duplex` so it can be
 * registered with any `webrun-streams-*` adapter's `serve`.
 */
export function serveFetchOverDuplex(handler: (request: Request) => Promise<Response>): Duplex {
  return httpServe(async (env, body) => {
    const reqInit: RequestInit = {
      method: env.method,
      headers: env.headers,
    };
    if (env.method !== "GET" && env.method !== "HEAD") {
      reqInit.body = asyncIterableToReadable(body);
      (reqInit as RequestInit & { duplex?: string }).duplex = "half";
    }
    const request = new Request(env.url, reqInit);
    const response = await handler(request);
    const respEnv: ResponseEnvelope = {
      status: response.status,
      statusText: response.statusText,
      headers: headersToArray(response.headers),
    };
    return {
      envelope: respEnv,
      body: response.body ? readableToAsyncIterable(response.body) : undefined,
    };
  });
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
