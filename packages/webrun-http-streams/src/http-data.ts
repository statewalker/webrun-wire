import type { Duplex } from "@statewalker/webrun-streams";
import { deserializeError, serializeError } from "@statewalker/webrun-streams";
import { discard } from "./bytes.js";
import { defaultCodec } from "./codec-default.js";
import type { ByteSource, MessageCodec, RequestEnvelope, ResponseEnvelope } from "./message.js";

/** Carries the serialized JS error between two webrun peers. */
export const PEER_ERROR_HEADER = "x-webrun-error";

export type HttpDataOptions = {
  /** Wire format. Defaults to `defaultCodec`: writes HTTP/1.1, accepts either. */
  codec?: MessageCodec;
};

export interface HttpFetchResult {
  envelope: ResponseEnvelope;
  body: AsyncIterable<Uint8Array>;
}

export interface HttpDataHandlerResult {
  envelope: ResponseEnvelope;
  body?: ByteSource;
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
 * JSON with every non-printable-ASCII character escaped, so the result is a
 * legal latin-1 header value whatever the error message contained.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7E]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Decision 13: a real HTTP peer cannot receive a JavaScript exception, only a
 * response. So an uncaught handler error becomes a conforming 500 whose body
 * carries the message, with the serialized error in a namespaced header that
 * another webrun peer re-throws from.
 */
function encodeErrorResponse(
  codec: MessageCodec,
  error: unknown,
  method: string,
): AsyncGenerator<Uint8Array> {
  const serialized = serializeError(error);
  let detail = asciiJson(serialized);
  if (detail.length > 4096) detail = asciiJson({ message: serialized.message });
  const message = serialized.message ?? "Internal Server Error";
  return codec.encodeResponse(
    {
      status: 500,
      statusText: "Internal Server Error",
      headers: [
        ["Content-Type", "text/plain; charset=utf-8"],
        [PEER_ERROR_HEADER, detail],
      ],
    },
    [new TextEncoder().encode(message)],
    { method },
  );
}

/**
 * `output` is the `Duplex` call's own generator — one logical call, per the
 * `Duplex` contract in `@statewalker/webrun-streams`: "Consumer `.return()`
 * on the output → producer's `finally` runs." On a mux transport
 * (`emulateMux`), that `finally` is what frees the stream-table slot; skip it
 * and every peer-error response leaks one slot, unboundedly, until the mux
 * itself is exhausted (`maxStreams` reached, every further call rejected).
 *
 * Cancelling `output` here — not inside the codec's own decode logic — is
 * deliberate. `codec.decodeResponse` already pulled from `output` to read the
 * head before this function runs, so unlike the body case above there's no
 * suspended-start no-op to worry about. And it's safe specifically *because*
 * this is the client's own response-only generator: the request was already
 * fully sent before we got here, so there is nothing left to write on it.
 * The equivalent is NOT safe inside `src/http1/decode.ts`'s `ByteReader` —
 * that code also runs when a caller wires `codec.decodeRequest`/
 * `decodeResponse` directly onto a raw bidirectional socket (see
 * `tests/http1-node-interop.test.ts`), where the *same* object is read from
 * and then written back to (a server reads the request, then replies on the
 * same socket); cancelling the read side there tears down the whole
 * connection out from under the pending write. That was tried and reverted —
 * see the Task 11 report for the "socket hang up" failure it caused.
 */
async function throwIfPeerError(
  result: HttpFetchResult,
  output: AsyncGenerator<Uint8Array>,
): Promise<void> {
  const found = result.envelope.headers.find(([k]) => k.toLowerCase() === PEER_ERROR_HEADER);
  if (!found) return;
  await discard(result.body);
  await output.return?.(undefined);
  let payload: { message: string };
  try {
    payload = JSON.parse(found[1]) as { message: string };
  } catch {
    payload = { message: found[1] };
  }
  throw deserializeError(payload);
}

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
  body?: ByteSource,
  options: HttpDataOptions = {},
): Promise<HttpFetchResult> {
  const codec = options.codec ?? defaultCodec;
  const output = call(codec.encodeRequest(env, body));
  const result = await codec.decodeResponse(output, { method: env.method });
  await throwIfPeerError(result, output);
  return result;
}

/**
 * Wrap an HTTP handler as a `Duplex` so it can be registered with any
 * `webrun-streams-*` adapter's `serve`.
 */
export function httpServe(handler: HttpDataHandler, options: HttpDataOptions = {}): Duplex {
  const codec = options.codec ?? defaultCodec;
  return async function* httpHandlerDuplex(input) {
    const decoded = await codec.decodeRequest(input);
    // Reply in kind: answer with the codec that actually read the request, so a
    // peer pinned to one format is never answered in the other.
    const replyCodec = decoded.codec ?? codec;
    let result: HttpDataHandlerResult;
    try {
      result = await handler(decoded.envelope, decoded.body);
    } catch (error) {
      yield* encodeErrorResponse(replyCodec, error, decoded.envelope.method);
      return;
    }
    yield* replyCodec.encodeResponse(result.envelope, result.body, {
      method: decoded.envelope.method,
    });
  };
}
