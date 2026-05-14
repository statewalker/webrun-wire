/**
 * Wire-level "cancel this sub-channel" signal.
 *
 * Used by `ioSend` when the consumer breaks out of the bidi stream early
 * (`iter.return()`) so the producer-side `ioHandle` can stop generating
 * chunks immediately instead of waiting for `callPort` timeouts to fire.
 *
 * Format: `port.postMessage({ type: "cancel-channel", channelName })`.
 * Fire-and-forget; no callId, no response.
 */
export const CANCEL_CHANNEL_TYPE = "cancel-channel";

interface CancelChannelMessage {
  type: typeof CANCEL_CHANNEL_TYPE;
  channelName: string;
}

export function postCancelChannel(port: MessagePort, channelName: string): void {
  if (!channelName) return;
  try {
    port.postMessage({ type: CANCEL_CHANNEL_TYPE, channelName } satisfies CancelChannelMessage);
  } catch {
    /* port may be closed — best effort */
  }
}

export function listenCancelChannel(
  port: MessagePort,
  channelName: string,
  onCancel: () => void,
): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data as CancelChannelMessage | undefined;
    if (!data || data.type !== CANCEL_CHANNEL_TYPE) return;
    if (data.channelName !== channelName) return;
    onCancel();
  };
  port.addEventListener("message", handler);
  return () => port.removeEventListener("message", handler);
}
