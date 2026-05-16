/**
 * Structural subset of the WHATWG `WebSocket` interface that also matches the
 * Node.js `ws` package. Anything that implements this surface works with the
 * helpers in this package.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Blob | Uint8Array): void;
  close(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "error", listener: () => void): void;
}

export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
