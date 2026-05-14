import type { RequestEnvelope, ResponseEnvelope } from "../envelope.js";
import { type HttpFetchOptions, httpFetch } from "../http-fetch.js";
import { httpServe } from "../http-serve.js";

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
    // On early termination (iter.return() before the body finishes), cancel
    // the upstream stream so its source's `cancel()` callback fires. Critical
    // for long-running response bodies (SSE, streamed AI output) that need
    // a signal to stop generating once the consumer goes away.
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
 * Make an HTTP call over a `MessagePort` and resolve to a standard `Response`.
 */
export async function fetchOverPort(
  port: MessagePort,
  request: Request,
  options: HttpFetchOptions = {},
): Promise<Response> {
  const env: RequestEnvelope = {
    url: request.url,
    method: request.method,
    headers: headersToArray(request.headers),
  };
  const signal = options.signal ?? request.signal;
  const body = request.body ? readableToAsyncIterable(request.body) : undefined;
  const { envelope, body: respBody } = await httpFetch(port, env, body, { signal });
  return new Response(asyncIterableToReadable(respBody), {
    status: envelope.status,
    statusText: envelope.statusText,
    headers: envelope.headers,
  });
}

/**
 * Register an HTTP handler on a `MessagePort` that receives standard `Request`
 * objects and returns standard `Response` objects.
 */
export function serveFetchOverPort(
  port: MessagePort,
  handler: (request: Request, signal: AbortSignal) => Promise<Response>,
): () => void {
  return httpServe(port, async (env, body, signal) => {
    const reqInit: RequestInit = {
      method: env.method,
      headers: env.headers,
    };
    // GET / HEAD cannot have a body per spec.
    if (env.method !== "GET" && env.method !== "HEAD") {
      reqInit.body = asyncIterableToReadable(body);
      (reqInit as RequestInit & { duplex?: string }).duplex = "half";
    }
    const request = new Request(env.url, reqInit);
    const response = await handler(request, signal);
    const respEnv: ResponseEnvelope = {
      status: response.status,
      statusText: response.statusText,
      headers: headersToArray(response.headers),
    };
    return {
      envelope: respEnv,
      body: response.body ? readableToAsyncIterable(response.body) : (async function* () {})(),
    };
  });
}
