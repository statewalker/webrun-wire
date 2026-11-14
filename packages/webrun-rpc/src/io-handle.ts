import { listenCancelChannel, postCancelChannel } from "./cancel-channel.js";
import type { ListenPortOptions } from "./listen-port.js";
import type { MessageTarget } from "./message-target.js";
import { receive } from "./receive.js";
import { send } from "./send.js";

/**
 * Server half of a full-duplex exchange over any `MessageTarget`.
 *
 * For each inbound stream, invokes `handler` with the stream, sends the
 * handler's output back, and yields a counter. The generator never ends
 * on its own — consumers break when they want to stop. Pairs with
 * {@link ioSend}.
 *
 * If the peer (the consumer of our outbound send) posts a `cancel-channel`
 * message on the same sub-channel, we abort `send` immediately. This makes
 * `ioSend`'s `iter.return()` propagate cleanly without waiting for
 * `callPort` timeouts. The other way round, when the handler stops without
 * reading its input to the end, we post `cancel-channel` so the peer's
 * `ioSend` stops sending chunks nobody will answer.
 */
export async function* ioHandle<T, U = T>(
  port: MessageTarget,
  handler: (input: AsyncIterable<T>) => AsyncIterable<U> | Promise<AsyncIterable<U>>,
  options: ListenPortOptions = {},
): AsyncGenerator<number> {
  let counter = 0;
  const channelName = options.channelName ?? "";
  for await (const input of receive<T>(port, options)) {
    const sendAbort = new AbortController();
    const unsubscribeCancel = channelName
      ? listenCancelChannel(port, channelName, () => sendAbort.abort())
      : () => {};
    // Whether the handler read its input to the end. If it stopped early, this
    // side no longer answers the peer's chunk calls, and the peer's `send`
    // (no per-chunk deadline) would wait for ever: tell it to stop.
    let inputEnded = false;
    const tracked = (async function* () {
      yield* input;
      inputEnded = true;
    })();
    try {
      const output = await handler(tracked);
      await send<U>(port, output, { ...options, signal: sendAbort.signal });
    } finally {
      unsubscribeCancel();
      if (!inputEnded) postCancelChannel(port, channelName);
    }
    yield counter++;
  }
}
