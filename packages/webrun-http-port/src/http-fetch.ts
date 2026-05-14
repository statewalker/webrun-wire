import { callBidi } from "@statewalker/webrun-ports";
import {
  decodeMessage,
  encodeMessage,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "./envelope.js";

export interface HttpFetchOptions {
  signal?: AbortSignal;
}

export interface HttpFetchResult {
  envelope: ResponseEnvelope;
  body: AsyncIterable<Uint8Array>;
}

/**
 * Initiate an HTTP call over a `MessagePort`. The port must be wired to a peer
 * running `httpServe`. Returns the response envelope and an async iterable of
 * response body bytes.
 *
 * The call is multiplexed through `callBidi` and tagged with `protocol: "http"`;
 * multiple concurrent `httpFetch` calls share the same `MessagePort` via
 * `callBidi`'s per-call sub-channel allocation.
 *
 * If `options.signal` aborts, the underlying `callBidi` sub-channel is torn
 * down and any in-flight body iteration rejects with the abort reason.
 */
export async function httpFetch(
  port: MessagePort,
  env: RequestEnvelope,
  body?: AsyncIterable<Uint8Array>,
  options: HttpFetchOptions = {},
): Promise<HttpFetchResult> {
  const signal = options.signal;
  if (signal?.aborted) throw abortReason(signal);

  // `protocol: "http"` tags the call so the server can filter for HTTP traffic.
  // `options.timeout` is large so paused HTTP streams (e.g. SSE) don't time
  // out per-chunk; the user-supplied AbortSignal is the cancellation primitive.
  const callIter = callBidi<unknown, Uint8Array>(port, encodeMessage(env, body), {
    protocol: "http",
    options: { timeout: 2147483647 },
  });

  let aborted = false;
  const abortError = () => {
    return signal ? abortReason(signal) : new Error("Aborted");
  };
  const onAbort = () => {
    aborted = true;
    void (callIter as AsyncGenerator<unknown, void, undefined>).return?.(undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const inputStream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (aborted) throw abortError();
          const r = await callIter.next();
          if (r.done) return { value: undefined, done: true } as IteratorResult<Uint8Array>;
          return { value: r.value as Uint8Array, done: false };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await (callIter as AsyncGenerator<unknown, void, undefined>).return?.(undefined);
          return { value: undefined, done: true } as IteratorResult<Uint8Array>;
        },
      };
    },
  };

  let result: { envelope: ResponseEnvelope; body: AsyncIterable<Uint8Array> };
  try {
    result = await decodeMessage<ResponseEnvelope>(inputStream);
  } catch (err) {
    signal?.removeEventListener("abort", onAbort);
    throw err;
  }

  const inner = result.body;
  async function* bodyWithCleanup(): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of inner) {
        if (aborted) throw abortError();
        yield chunk;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return { envelope: result.envelope, body: bodyWithCleanup() };
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as unknown as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined ? "Aborted" : String(reason));
  err.name = "AbortError";
  return err;
}
