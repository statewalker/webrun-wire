import { bindBytesToPort, normalizeToUint8Array } from "@statewalker/webrun-port-core";
import { type WebSocketLike, WS_READY_STATE } from "./websocket-like.js";

/**
 * Default MTU for messages flowing through a WebSocket. Most browser and Node
 * WebSocket implementations accept much larger frames, but keeping a sensible
 * upper bound here means transparent chunking kicks in for very large payloads
 * without surprising memory pressure.
 */
const DEFAULT_WS_MTU = 1 << 20; // 1 MiB

/**
 * Wrap an open WebSocket into a real `MessagePort`. The far end of the port
 * lives at the peer of the WebSocket.
 *
 * The WebSocket must already be in the `OPEN` state. Use
 * {@link waitForWebSocketOpen} first if you hold a still-connecting socket,
 * or pass a URL into a higher-level helper that does this for you.
 */
export function createWebSocketPort(ws: WebSocketLike, mtu = DEFAULT_WS_MTU): MessagePort {
  let chunkHandler: ((bytes: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  const onMessage = (event: MessageEvent) => {
    if (!chunkHandler) return;
    const data = event.data as unknown;
    if (data instanceof Uint8Array) {
      chunkHandler(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      chunkHandler(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      chunkHandler(
        new Uint8Array(
          (data as ArrayBufferView).buffer,
          (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength,
        ),
      );
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => chunkHandler?.(new Uint8Array(buf)));
      return;
    }
    if (typeof data === "string") {
      // Treat string frames as their UTF-8 bytes. WebSocket text frames are
      // unusual on this transport — adapters should send binary — but we
      // still relay them faithfully rather than dropping them.
      const normalised = normalizeToUint8Array(data);
      if (normalised instanceof Uint8Array) {
        chunkHandler(normalised);
      } else {
        void normalised.then((bytes) => chunkHandler?.(bytes));
      }
    }
  };

  const onClose = () => {
    closeHandler?.();
  };

  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);

  return bindBytesToPort({
    postChunk(bytes) {
      if (ws.readyState !== WS_READY_STATE.OPEN) return;
      ws.send(bytes);
    },
    onChunk(handler) {
      chunkHandler = handler;
      return () => {
        if (chunkHandler === handler) chunkHandler = null;
      };
    },
    onClose(handler) {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    },
    close() {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      if (ws.readyState === WS_READY_STATE.OPEN || ws.readyState === WS_READY_STATE.CONNECTING) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    },
    mtu,
  });
}
