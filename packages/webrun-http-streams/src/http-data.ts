import type { Duplex } from "@statewalker/webrun-streams";
import {
  decodeMessage,
  encodeMessage,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "./envelope.js";

export interface HttpFetchResult {
  envelope: ResponseEnvelope;
  body: AsyncIterable<Uint8Array>;
}

export interface HttpDataHandlerResult {
  envelope: ResponseEnvelope;
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

/**
 * Low-level HTTP-over-Duplex handler. Takes the request envelope plus body
 * iterator; returns the response envelope and optional body.
 *
 * For the higher-level `(Request) => Promise<Response>` shape — the
 * conventional `HttpHandler` used by `webrun-http-browser` and `SiteBuilder`
 * — see `http-stubs.ts` and `fetch.ts`.
 */
export type HttpDataHandler = (
  env: RequestEnvelope,
  body: AsyncIterable<Uint8Array>,
) => Promise<HttpDataHandlerResult>;

/**
 * Initiate an HTTP call over a `Duplex`. The caller's `call: Duplex` is
 * obtained from any `webrun-streams-*` adapter's `connect`. Returns the
 * response envelope and an async iterable over the response body bytes.
 *
 * The call is one logical Duplex invocation; multiplexing of concurrent
 * calls is the adapter's concern (native or `emulateMux`).
 */
export async function httpFetch(
  call: Duplex,
  env: RequestEnvelope,
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<HttpFetchResult> {
  const output = call(encodeMessage(env, body));
  return decodeMessage<ResponseEnvelope>(output);
}

/**
 * Wrap an HTTP handler as a `Duplex` so it can be registered with any
 * `webrun-streams-*` adapter's `serve`. The duplex `split`s the input to
 * recover envelope + body, dispatches to the handler, and emits the response
 * via `encodeMessage`.
 */
export function httpServe(handler: HttpDataHandler): Duplex {
  return async function* httpHandlerDuplex(input) {
    const { envelope: reqEnv, body: reqBody } = await decodeMessage<RequestEnvelope>(input);
    const result = await handler(reqEnv, reqBody);
    yield* encodeMessage(result.envelope, result.body);
  };
}
