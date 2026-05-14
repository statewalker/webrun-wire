import {
  type HttpHandler,
  newHttpClientStub,
  newHttpServerStub,
  type SerializedHttpEnvelope,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from "@statewalker/webrun-http";
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
 * @deprecated For new code, prefer the `MessagePort`-based stack from
 * `@statewalker/webrun-http-port`. Once a `MessagePort` is established between
 * page and worker, `httpServe(port, handler)` provides equivalent semantics
 * with `callBidi` multiplexing, full-duplex streaming, and `AbortSignal`.
 * This helper remains for existing ServiceWorker setups that still consume the
 * `MessageTarget` surface; it will be reimplemented on top of
 * `webrun-http-port` in a follow-up release.
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
 * @deprecated For new code, prefer the `MessagePort`-based stack from
 * `@statewalker/webrun-http-port/fetch`. Once the page and SW share a
 * `MessagePort`, `fetchOverPort(port, request)` provides the same
 * `Request → Response` semantics with multiplexing via `callBidi`, JSONL
 * envelope framing, and native `AbortSignal` support. This helper remains for
 * existing ServiceWorker setups; it will be reimplemented on top of
 * `webrun-http-port` in a follow-up release.
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
