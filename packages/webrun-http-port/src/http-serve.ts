import { ioHandle, listenPort } from "@statewalker/webrun-ports";
import {
  decodeMessage,
  encodeMessage,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "./envelope.js";

export interface HttpHandlerResult {
  envelope: ResponseEnvelope;
  body: AsyncIterable<Uint8Array>;
}

export type HttpHandler = (
  env: RequestEnvelope,
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
) => Promise<HttpHandlerResult>;

const BIG_TIMEOUT = 2147483647; // ~24 days; max 32-bit setTimeout value

/**
 * Listen for HTTP calls on a `MessagePort`. Returns an unsubscribe function
 * that removes the listener.
 *
 * The handler receives the incoming `RequestEnvelope`, an async iterable over
 * the request body bytes, and an `AbortSignal` that fires when the client
 * cancels or the port closes. It must return a `ResponseEnvelope` plus an
 * async iterable of response body bytes.
 *
 * Implementation note: this bypasses `listenBidi` so we can pass a long
 * timeout to the underlying per-chunk `callPort` round-trips. HTTP bodies can
 * legitimately pause between chunks for far longer than `callPort`'s default
 * 1-second timeout (think SSE / AI streaming).
 */
export function httpServe(port: MessagePort, handler: HttpHandler): () => void {
  return listenPort(port, async (params) => {
    const p = params as { channelName?: unknown; protocol?: unknown };
    if (typeof p.channelName !== "string") return;
    if (p.protocol !== "http") return;
    const subChannel = p.channelName;

    const action = async (input: AsyncIterable<Uint8Array>): Promise<AsyncIterable<Uint8Array>> => {
      const abortController = new AbortController();
      const { envelope: reqEnv, body: reqBody } = await decodeMessage<RequestEnvelope>(input);

      // The handler may consume `reqBody` partially or not at all. The wire
      // protocol requires every chunk the client sent (including the `done`
      // marker) to be dequeued from the server-side `recieveIterator`,
      // otherwise the client's `send` deadlocks waiting for the final ack.
      // We expose the iterator to the handler AND retain a handle to drain
      // any leftover chunks after the handler returns.
      const sharedIter = reqBody[Symbol.asyncIterator]();
      let drained = false;
      const handlerBody: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (drained) return { value: undefined, done: true } as IteratorResult<Uint8Array>;
              const r = await sharedIter.next();
              if (r.done) drained = true;
              return r;
            },
            async return() {
              drained = true;
              return { value: undefined, done: true } as IteratorResult<Uint8Array>;
            },
          };
        },
      };

      let result: HttpHandlerResult;
      try {
        result = await handler(reqEnv, handlerBody, abortController.signal);
      } catch (err) {
        abortController.abort(err as Error);
        throw err;
      }

      // After the handler returns, drain any remaining request chunks in the
      // background — this releases the client's pending `send` calls.
      const drainTask = (async () => {
        try {
          while (!drained) {
            const r = await sharedIter.next();
            if (r.done) {
              drained = true;
              break;
            }
          }
        } catch {
          drained = true;
        }
      })();

      // Wrap encodeMessage so the drain completes before the action's output
      // stream ends. ioHandle's send waits for the output stream to fully
      // exhaust before issuing its `{done: true}` ack, so this guarantees the
      // server-side request iterator has been fully consumed by then.
      return (async function* () {
        yield* encodeMessage(result.envelope, result.body);
        await drainTask;
      })();
    };

    for await (const _idx of ioHandle<Uint8Array, Uint8Array>(port, action, {
      channelName: subChannel,
      ...({ timeout: BIG_TIMEOUT } as object),
    })) {
      void _idx;
      break;
    }
  });
}
