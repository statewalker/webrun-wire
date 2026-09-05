import { ioHandle } from "./io-handle.js";
import { listenPort } from "./listen-port.js";

export type BidiHandler<TIn, TOut> = (
  input: AsyncIterable<TIn>,
  params: Record<string, unknown>,
) => AsyncIterable<TOut> | Promise<AsyncIterable<TOut>>;

/**
 * Server half of {@link callBidi}: listens for stream-call requests on `port`
 * and dispatches each accepted one to `action`.
 *
 * The optional `accept` predicate can inspect the incoming params and reject
 * unwanted calls. Returns a cleanup function that removes the listener.
 */
export function listenBidi<TIn, TOut>(
  port: MessagePort,
  action: BidiHandler<TIn, TOut>,
  accept: (params: Record<string, unknown>) => boolean = () => true,
): () => void {
  return listenPort(port, async (params: Record<string, unknown>) => {
    if (!params || typeof params.channelName !== "string") return;
    if (!accept(params)) return;
    const handler = async (input: AsyncIterable<TIn>) => action(input, params);
    for await (const _idx of ioHandle<TIn, TOut>(port, handler, params)) {
      void _idx;
      break;
    }
  });
}
