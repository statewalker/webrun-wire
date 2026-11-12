import { type WebSocketLike, WS_READY_STATE } from "./websocket-like.js";

type Listener = (event: MessageEvent) => void | Promise<void>;

/** What `messageTargetOverWebSocket` gives: a pipe of bytes, and its life. */
export interface WebSocketMessageTarget {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) whose messages
   * are `Uint8Array`s, one WebSocket message each.
   */
  target: {
    addEventListener(type: "message", listener: Listener): void;
    removeEventListener(type: "message", listener: Listener): void;
    /** Sends one binary message. Throws `TypeError` for anything but bytes. */
    postMessage(message: unknown): void;
    /** Closes the socket. */
    close(): Promise<void>;
    /** The socket's `bufferedAmount`: bytes sent and not yet written out. */
    readonly bufferedAmount: number;
    /** Resolves once the socket has written out what it holds, or has closed. */
    whenDrained(): Promise<void>;
  };
  /**
   * Aborts when the socket closes, with an `Error` saying how. Pass it as
   * `multiplexPort`'s / `overPipe`'s `signal`, so a dead peer closes the
   * multiplexer and every port on it at once instead of leaving them open.
   */
  signal: AbortSignal;
}

/** How often `whenDrained` looks at `bufferedAmount`: a WebSocket has no drain event. */
const DRAIN_POLL_MS = 5;

const encoder = new TextEncoder();

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
 * message overtake it. A text message arrives as its UTF-8 bytes. Messages
 * reaching no listener are dropped, as on a `MessagePort`. The adapter imports
 * nothing from this repository; the target is a `MessageTarget` by shape.
 */
export function messageTargetOverWebSocket(ws: WebSocketLike): WebSocketMessageTarget {
  if (ws.readyState !== WS_READY_STATE.OPEN) {
    throw new Error(
      `messageTargetOverWebSocket: WebSocket is in readyState ${ws.readyState}, expected OPEN (1)`,
    );
  }
  if (ws.binaryType === "blob") ws.binaryType = "arraybuffer";
  const listeners = new Set<Listener>();
  const life = new AbortController();

  const deliver = (data: Uint8Array): void => {
    const event = new MessageEvent("message", { data });
    for (const listener of [...listeners]) {
      try {
        // One listener's fault, thrown or rejected, must not stop delivery.
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {}
    }
  };
  const onMessage = (event: MessageEvent): void => {
    if (life.signal.aborted) return;
    const bytes = toBytes(event.data);
    if (bytes) deliver(bytes);
    else if (typeof event.data === "string") deliver(encoder.encode(event.data));
  };
  const end = (reason: Error): void => {
    if (life.signal.aborted) return;
    ws.removeEventListener("message", onMessage);
    ws.removeEventListener("close", onClose);
    life.abort(reason);
  };
  const onClose = (event?: unknown): void => {
    const code = (event as { code?: number } | undefined)?.code;
    end(new Error(`webrun-streams-ws: the WebSocket closed${code ? ` (code ${code})` : ""}`));
  };
  ws.addEventListener("message", onMessage);
  // A failing socket fires `error` and then always `close`: `close` alone ends it.
  ws.addEventListener("close", onClose);

  return {
    signal: life.signal,
    target: {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message) {
        const bytes = toBytes(message);
        if (!bytes) {
          throw new TypeError(
            `webrun-streams-ws: a byte pipe carries Uint8Array, ArrayBuffer or a view, got ${Object.prototype.toString.call(message)}`,
          );
        }
        if (life.signal.aborted || ws.readyState !== WS_READY_STATE.OPEN) return; // `signal` says so
        ws.send(bytes);
      },
      async close() {
        listeners.clear();
        end(new Error("webrun-streams-ws: closed locally"));
        try {
          ws.close();
        } catch {}
      },
      get bufferedAmount() {
        return ws.bufferedAmount ?? 0;
      },
      whenDrained() {
        return new Promise<void>((resolve) => {
          const check = (): void => {
            if (life.signal.aborted || !(ws.bufferedAmount ?? 0)) resolve();
            else setTimeout(check, DRAIN_POLL_MS);
          };
          check();
        });
      },
    },
  };
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
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
