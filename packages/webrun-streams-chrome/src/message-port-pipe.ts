import { type MessagePipe, newMessagePipe } from "@statewalker/webrun-streams";

/** The control message a pipe posts before it closes its port. */
export const PIPE_CLOSED = "webrun-pipe-closed";

/** The slice of a `MessagePort` the pipe touches. A real port satisfies it. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

export interface MessagePortPipeOptions {
  /** The payload ceiling the pipe reports, for `overPipe`'s `maxMessageSize`. Default: none. */
  maxMessageSize?: number;
  /** Prefix of the pipe's errors. Default `"webrun-streams-port"`. */
  name?: string;
}

interface ClosedMessage {
  type: typeof PIPE_CLOSED;
  reason?: string;
}

function isClosedMessage(data: unknown): data is ClosedMessage {
  return (
    typeof data === "object" && data !== null && (data as { type?: unknown }).type === PIPE_CLOSED
  );
}

/**
 * One `MessagePort` as a pipe of bytes: a page and its extension's content
 * script talk over one, since a page cannot reach a `chrome.runtime.Port`.
 *
 * Each frame is a copy whose buffer is transferred. A `MessagePort` tells the
 * other side nothing when it closes, so a closing pipe first posts
 * `{ type: "webrun-pipe-closed", reason }`, and a pipe that receives it ends
 * with that reason: this is how a page learns that the service worker behind
 * the content script went away. `target.close(reason)` passes a reason on.
 */
export function messagePortPipe(
  port: MessagePortLike,
  options: MessagePortPipeOptions = {},
): MessagePipe {
  const { maxMessageSize, name = "webrun-streams-port" } = options;
  let peerClosed = false;

  const onMessage = (event: MessageEvent): void => {
    const data = event.data;
    if (isClosedMessage(data)) {
      peerClosed = true;
      control.end(new Error(`${name}: the peer closed${data.reason ? `: ${data.reason}` : ""}`));
      return;
    }
    control.deliver(data);
  };

  const control = newMessagePipe(
    {
      send(bytes) {
        // `copyOnSend`: `bytes` is a copy this pipe owns, so its buffer can go.
        port.postMessage(bytes, [bytes.buffer as ArrayBuffer]);
      },
      close(local, reason) {
        port.removeEventListener("message", onMessage);
        if (local && !peerClosed) {
          const closed: ClosedMessage = { type: PIPE_CLOSED, reason: reason.message };
          try {
            port.postMessage(closed);
          } catch {}
        }
        try {
          port.close();
        } catch {}
      },
    },
    { name, maxMessageSize, copyOnSend: true },
  );
  port.addEventListener("message", onMessage);
  port.start?.();
  return control.pipe;
}
