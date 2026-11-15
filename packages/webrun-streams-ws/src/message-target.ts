import {
  DEFAULT_DRAIN_LOW_WATER,
  type MessagePipe,
  type MessagePipeTarget,
  newMessagePipe,
} from "@statewalker/webrun-streams";
import { type WebSocketLike, WS_READY_STATE } from "./websocket-like.js";

/** What `messageTargetOverWebSocket` gives: a pipe of bytes, and its life. */
export interface WebSocketMessageTarget extends MessagePipe {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) whose messages
   * are `Uint8Array`s, one WebSocket message each. `bufferedAmount` is the
   * socket's; `whenDrained` resolves once it is at most
   * {@link DRAIN_LOW_WATER}, or the socket has closed.
   */
  target: MessagePipeTarget;
  /**
   * Aborts when the socket closes, with an `Error` saying how; the same as
   * `target.closeSignal`. Pass it as `multiplexPort`'s / `overPipe`'s
   * `signal`, so a dead peer closes the multiplexer and every port on it at
   * once instead of leaving them open.
   */
  signal: AbortSignal;
}

export interface MessageTargetOverWebSocketOptions {
  /**
   * The largest message posted; past it the pipe ends with a `RangeError`.
   * Default: none, a WebSocket carries messages of any size.
   */
  maxFrameBytes?: number;
  /** The payload ceiling to report, for `overPipe`'s `maxMessageSize`. Default: none. */
  maxMessageSize?: number;
}

/**
 * `whenDrained` resolves once `bufferedAmount` is at most this: the socket can
 * take more. Waiting for zero would make a sender that waits before every
 * frame (`overPipe`'s `frameSize`) pause a poll interval per frame.
 */
export const DRAIN_LOW_WATER = DEFAULT_DRAIN_LOW_WATER;

/**
 * One open WebSocket as a pipe of messages, for a multiplexer to run over:
 *
 * ```ts
 * const { target, signal } = messageTargetOverWebSocket(ws);
 * const { call } = await connect({
 *   mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal }),
 * });
 * ```
 *
 * The socket must be `OPEN`. Binary messages arrive as `Uint8Array`, in order:
 * a browser socket still on the default `binaryType` "blob" is switched to
 * "arraybuffer", because reading a `Blob` is asynchronous and would let a later
 * message overtake it. A text message arrives as its UTF-8 bytes; anything
 * else ends the pipe with a `TypeError`. Messages reaching no listener are
 * dropped, as on a `MessagePort`. Built on `newMessagePipe`
 * (`@statewalker/webrun-streams`), which owns the pipe's rules.
 */
export function messageTargetOverWebSocket(
  ws: WebSocketLike,
  options: MessageTargetOverWebSocketOptions = {},
): WebSocketMessageTarget {
  if (ws.readyState !== WS_READY_STATE.OPEN) {
    throw new Error(
      `messageTargetOverWebSocket: WebSocket is in readyState ${ws.readyState}, expected OPEN (1)`,
    );
  }
  // "arraybuffer" (browsers) and "nodebuffer" (`ws`) arrive as bytes at once;
  // anything else — "blob" (read asynchronously, so a later message could
  // overtake it), `ws`'s "fragments" (an array of Buffers) — is switched.
  if (
    ws.binaryType !== undefined &&
    ws.binaryType !== "arraybuffer" &&
    ws.binaryType !== "nodebuffer"
  )
    ws.binaryType = "arraybuffer";

  const onMessage = (event: MessageEvent): void => control.deliver(event.data);
  const onClose = (event?: unknown): void => {
    const code = (event as { code?: number } | undefined)?.code;
    control.end(
      new Error(`webrun-streams-ws: the WebSocket closed${code ? ` (code ${code})` : ""}`),
    );
  };
  const control = newMessagePipe(
    {
      send: (bytes) => ws.send(bytes),
      canSend: () => ws.readyState === WS_READY_STATE.OPEN,
      bufferedAmount: () => ws.bufferedAmount ?? 0,
      close: (local) => {
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        if (local) {
          try {
            ws.close();
          } catch {}
        }
      },
    },
    {
      name: "webrun-streams-ws",
      textAsBytes: true,
      maxFrameBytes: options.maxFrameBytes,
      maxMessageSize: options.maxMessageSize,
    },
  );
  ws.addEventListener("message", onMessage);
  // A failing socket fires `error` and then always `close`: `close` alone ends it.
  ws.addEventListener("close", onClose);
  return control.pipe as WebSocketMessageTarget;
}

export interface OpenWebSocketParams {
  /** WebSocket URL (`ws://` or `wss://`). */
  url: string;
  /** Optional subprotocol(s) passed to the WebSocket constructor. */
  protocols?: string | string[];
  /**
   * WebSocket constructor. Defaults to the global `WebSocket` when present;
   * pass the `ws` package's `WebSocket` in Node versions without one.
   */
  WebSocketCtor?: new (
    url: string,
    protocols?: string | string[],
  ) => WebSocketLike;
}

/** Opens a WebSocket and resolves once it is `OPEN`; rejects if it fails or closes first. */
export async function openWebSocket(params: OpenWebSocketParams): Promise<WebSocketLike> {
  const Ctor = params.WebSocketCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Ctor) {
    throw new Error(
      "webrun-streams-ws: no WebSocket constructor available. Pass `WebSocketCtor` (e.g. the `ws` package's WebSocket in Node).",
    );
  }
  const ws = new Ctor(params.url, params.protocols) as WebSocketLike;
  await waitForOpen(ws);
  return ws;
}

/** Resolves once `ws` is `OPEN`; rejects if it fails or closes first. */
export function waitForOpen(ws: WebSocketLike): Promise<void> {
  if (ws.readyState === WS_READY_STATE.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onCloseEarly);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("WebSocket error before open"));
    };
    const onCloseEarly = (): void => {
      cleanup();
      reject(new Error("WebSocket closed before it opened"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onCloseEarly);
  });
}
