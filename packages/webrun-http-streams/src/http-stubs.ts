import { fromReadableStream, toReadableStream } from "@statewalker/webrun-streams";

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
    const content = request.body
      ? fromReadableStream(request.body as ReadableStream<Uint8Array>)
      : (async function* () {})();

    const result = await send({ options, content });

    if (!result) {
      return new Response(null, { status: 404, statusText: "Error 404: Not Found" });
    }

    const responseOptions = result.options;
    const method = options.method;
    if (method === "HEAD" || method === "OPTIONS") {
      const returnable = result.content as AsyncIterable<Uint8Array> & { return?: () => unknown };
      await returnable.return?.();
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
    let body: ReadableStream<Uint8Array> | undefined;
    if (hasBody) {
      body = toReadableStream(content[Symbol.asyncIterator]());
    } else {
      const returnable = content as AsyncIterable<Uint8Array> & { return?: () => unknown };
      await returnable.return?.();
    }

    const requestInit: RequestInit & { duplex?: "half" } = {
      ...forwardable,
      method,
      headers: requestHeaders,
    };
    if (hasBody) {
      requestInit.body = body;
      requestInit.duplex = "half";
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
