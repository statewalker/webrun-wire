import {
  type HttpHandler,
  newHttpClientStub,
  newHttpServerStub,
  type SerializedHttpEnvelope,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from "@statewalker/webrun-http-streams";
import { handleStreams, sendStream } from "../core/data-channels.js";
import type { MessageTarget } from "../core/message-target.js";

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
 * Serve an `HttpHandler` over a `MessageTarget`, using this package's own
 * `handleStreams` transport.
 *
 * @deprecated Prefer the port stack in `@statewalker/webrun-rpc`: open a port
 * (`multiplexPort` over one pipe, or `transferPortMux` where the platform can
 * transfer a real `MessagePort`), turn it into a `Duplex` with
 * `serveDuplexOverPort`, and serve HTTP on that with
 * `httpServe(handler, options)` from `@statewalker/webrun-http-streams`.
 *
 * That path has backpressure; **this one does not.** `sendStream`'s chunk
 * sender discards the promise it is given, so a fast producer over a slow
 * consumer accumulates without bound. It also has no per-stream timeout and no
 * chunking to a transport's message ceiling.
 *
 * Kept for existing ServiceWorker setups built on the `MessageTarget` surface.
 */
export function handleHttpRequests(
  communicationPort: MessageTarget,
  handler: HttpHandler,
): () => void {
  const serverStub = newHttpServerStub(handler);
  return handleStreams<Uint8Array>(communicationPort, async (it) => {
    const envelope = await httpFromIterator<SerializedHttpRequest>(it);
    const response = await serverStub(envelope);
    return httpToIterator(response);
  });
}

/**
 * Ship a `Request` over a `MessageTarget` and await the `Response`, using this
 * package's own `sendStream` transport.
 *
 * @deprecated Prefer the port stack in `@statewalker/webrun-rpc`: open a port
 * (`multiplexPort` over one pipe, or `transferPortMux` where the platform can
 * transfer a real `MessagePort`), turn it into a `Duplex` with
 * `duplexOverPort`, and drive HTTP over it with `httpFetch` from
 * `@statewalker/webrun-http-streams`.
 *
 * Same caveat as {@link handleHttpRequests}: the transport underneath this
 * helper has no backpressure, no per-stream timeout, and no chunking to a
 * transport's message ceiling. Kept for existing ServiceWorker setups.
 */
export async function sendHttpRequest(
  communicationPort: MessageTarget,
  request: Request,
): Promise<Response> {
  const clientStub = newHttpClientStub(async (req) => {
    return await httpFromIterator<SerializedHttpResponse>(
      sendStream<Uint8Array>(communicationPort, httpToIterator(req)),
    );
  });
  return await clientStub(request);
}
