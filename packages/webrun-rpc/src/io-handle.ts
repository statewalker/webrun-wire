import { listenCancelChannel } from "./cancel-channel.js";
import type { ListenPortOptions } from "./listen-port.js";
import { recieve } from "./recieve.js";
import { send } from "./send.js";

/**
 * Server half of a full-duplex exchange over a `MessagePort`.
 *
 * For each inbound stream, invokes `handler` with the stream, sends the
 * handler's output back, and yields a counter. The generator never ends
 * on its own — consumers break when they want to stop. Pairs with
 * {@link ioSend}.
 *
 * If the peer (the consumer of our outbound send) posts a `cancel-channel`
 * message on the same sub-channel, we abort `send` immediately. This makes
 * `ioSend`'s `iter.return()` propagate cleanly without waiting for
 * `callPort` timeouts.
 */
export async function* ioHandle<T, U = T>(
  port: MessagePort,
  handler: (input: AsyncIterable<T>) => AsyncIterable<U> | Promise<AsyncIterable<U>>,
  options: ListenPortOptions = {},
): AsyncGenerator<number> {
  let counter = 0;
  const channelName = options.channelName ?? "";
  for await (const input of recieve<T>(port, options)) {
    const sendAbort = new AbortController();
    const unsubscribeCancel = channelName
      ? listenCancelChannel(port, channelName, () => sendAbort.abort())
      : () => {};
    try {
      const output = await handler(input);
      await send<U>(port, output, { ...options, signal: sendAbort.signal });
    } finally {
      unsubscribeCancel();
    }
    yield counter++;
  }
}
