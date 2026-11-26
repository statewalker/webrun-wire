import { type MessagePipe, newMessagePipe } from "@statewalker/webrun-streams";
import { base64ToBytes, bytesToBase64 } from "./base64.js";
import type { ChromePortLike } from "./chrome-port-like.js";

export interface ChromePortPipeOptions {
  /**
   * The largest frame posted, in bytes before base64. Past it the pipe ends
   * with a `RangeError`. Default 32 MiB: Chrome refuses a port message over
   * 64 MiB of JSON, and base64 makes a frame a third larger.
   */
  maxFrameBytes?: number;
  /**
   * The payload ceiling the pipe reports, for `overPipe`'s `maxMessageSize`.
   * Default 1 MiB: frames of 256 KiB to 1 MiB stream fastest over a port.
   */
  maxMessageSize?: number;
  /** Prefix of the pipe's errors. Default `"webrun-streams-chrome"`. */
  name?: string;
}

/** Default `maxFrameBytes`: 32 MiB. */
export const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Default `maxMessageSize`: 1 MiB. */
export const DEFAULT_MAX_MESSAGE_SIZE = 1024 * 1024;

interface ChromeRuntimeGlobal {
  chrome?: { runtime?: { lastError?: { message?: string } } };
}

/**
 * One `chrome.runtime.Port` as a pipe of bytes, for a multiplexer to run over:
 *
 * ```ts
 * const port = chrome.runtime.connect({ name: "webrun" });
 * const { target } = chromePortPipe(port);
 * const { call } = await connect({
 *   mux: overPipe(target, { codec: msgpackCodec, side: "initiator", window: "auto" }),
 * });
 * ```
 *
 * A port carries JSON only, so each frame travels as one base64 string. The
 * pipe ends when the port disconnects (its reason names
 * `chrome.runtime.lastError` when Chrome set one), when a `postMessage`
 * throws, or when a message arrives that is not a string. Closing the pipe
 * disconnects the port. The port has no buffered amount and no drain event:
 * flow control is the multiplexer's per-port window, end to end.
 */
export function chromePortPipe(
  port: ChromePortLike,
  options: ChromePortPipeOptions = {},
): MessagePipe {
  const {
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE,
    name = "webrun-streams-chrome",
  } = options;
  let disconnected = false;

  const onMessage = (message: unknown): void => {
    if (typeof message !== "string") {
      // Not a frame: newMessagePipe ends the pipe with a TypeError.
      control.deliver(message);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(message);
    } catch {
      control.end(new TypeError(`${name}: a message arrived that is not base64`), true);
      return;
    }
    control.deliver(bytes);
  };
  const onDisconnect = (): void => {
    disconnected = true;
    const why = (globalThis as ChromeRuntimeGlobal).chrome?.runtime?.lastError?.message;
    control.end(
      new Error(`${name}: the chrome.runtime.Port disconnected${why ? ` (${why})` : ""}`),
    );
  };

  const control = newMessagePipe(
    {
      send(bytes) {
        try {
          port.postMessage(bytesToBase64(bytes));
        } catch (error) {
          // "Attempting to use a disconnected port object": Chrome has not
          // fired onDisconnect yet, or never will on this side.
          disconnected = true;
          control.end(error instanceof Error ? error : new Error(String(error)), true);
        }
      },
      canSend: () => !disconnected,
      close(local) {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        if (local && !disconnected) {
          disconnected = true;
          try {
            port.disconnect();
          } catch {}
        }
      },
    },
    { name, maxFrameBytes, maxMessageSize },
  );
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  return control.pipe;
}
