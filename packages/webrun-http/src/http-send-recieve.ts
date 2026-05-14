import {
  type HttpHandler,
  newHttpClientStub,
  newHttpServerStub,
  type SerializedHttpEnvelope,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from "./http-stubs.js";

type AnyEnvelope = SerializedHttpEnvelope<SerializedHttpRequest | SerializedHttpResponse>;

async function* httpToIterator(
  envelopeOrPromise: AnyEnvelope | Promise<AnyEnvelope>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const { options, content } = await envelopeOrPromise;
  const encoder = new TextEncoder();
  yield encoder.encode(JSON.stringify(options));
  yield* content;
}

async function httpFromIterator<Options>(
  iterable: AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>,
): Promise<SerializedHttpEnvelope<Options>> {
  const it = (await iterable)[Symbol.asyncIterator]();
  const { done, value } = await it.next();
  let options = {} as Options;
  if (!done && value) {
    const str = new TextDecoder().decode(value);
    options = JSON.parse(str) as Options;
  }
  const content: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return it;
    },
  };
  return { options, content };
}

/**
 * Returns a server-side pipe: given an incoming stream of serialized-request
 * bytes, yields the serialized-response bytes. Drop this onto any transport
 * that can pipe bytes between two endpoints.
 *
 * @deprecated Prefer `httpServe` from `@statewalker/webrun-http-port` for new
 * code. That layer carries the same HTTP-over-bytes idea but multiplexes
 * concurrent calls via `callBidi`, supports full-duplex streaming and
 * `AbortSignal` natively, and uses JSONL envelope framing that survives any
 * chunk boundary.
 */
export function newHttpServer(
  handler: HttpHandler,
): (input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array, void, unknown> {
  const serverStub = newHttpServerStub(handler);
  return async function* (input) {
    const envelope = await httpFromIterator<SerializedHttpRequest>(input);
    const response = await serverStub(envelope);
    yield* httpToIterator(response);
  };
}

/**
 * Returns a client-side handler: given an HTTP `Request`, it writes the
 * serialized form through `sendStream`, reads back the serialized
 * response, and resolves with a `Response`.
 *
 * @deprecated Prefer `fetchOverPort` from `@statewalker/webrun-http-port/fetch`
 * for new code. That layer takes a `MessagePort` directly, supports multiple
 * concurrent calls on the same port via `callBidi`, and ships full-duplex
 * streaming + `AbortSignal` out of the box.
 */
export function newHttpClient(
  sendStream: (input: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>,
): (request: Request) => Promise<Response> {
  const clientStub = newHttpClientStub(async (req) => {
    return await httpFromIterator<SerializedHttpResponse>(sendStream(httpToIterator(req)));
  });
  return (request) => clientStub(request);
}
