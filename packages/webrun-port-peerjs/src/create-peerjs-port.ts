import { bindBytesToPort } from "@statewalker/webrun-port-core";
import type { DataConnection } from "peerjs";

/**
 * PeerJS DataConnections wrap WebRTC DataChannels and share their MTU
 * characteristics. Stay conservative — the adaptive chunker in
 * `webrun-port-core` handles anything above this.
 */
const DEFAULT_PEERJS_MTU = 16 * 1024;

export interface CreatePeerJsPortOptions {
  /** Override the per-frame byte budget. Default ~16 KiB. */
  mtu?: number;
}

/**
 * Wrap an open PeerJS `DataConnection` into a real `MessagePort`. The far end
 * of the port lives at the remote peer of the DataConnection.
 *
 * The DataConnection MUST be constructed with `{ serialization: "raw" }` so
 * the adapter receives `Uint8Array` payloads instead of PeerJS's own JSON or
 * binary-packed envelopes. The adapter throws if the connection's serialization
 * mode is anything else.
 *
 * Signalling (peer-ID exchange, broker connection) is the caller's
 * responsibility. The adapter takes over once a DataConnection is `open`.
 */
export function createPeerJsPort(
  conn: DataConnection,
  options: CreatePeerJsPortOptions = {},
): MessagePort {
  const serialization = (conn as unknown as { serialization?: string }).serialization;
  if (serialization !== "raw") {
    throw new TypeError(
      `createPeerJsPort: DataConnection serialization is '${serialization}', expected 'raw'`,
    );
  }

  let chunkHandler: ((bytes: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  const onData = (data: unknown) => {
    const h = chunkHandler;
    if (!h) return;
    if (data instanceof Uint8Array) {
      h(new Uint8Array(data));
      return;
    }
    if (data instanceof ArrayBuffer) {
      h(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      h(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
      return;
    }
    // PeerJS in raw mode may still surface Blob in some browsers.
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        const inner = chunkHandler;
        if (inner) inner(new Uint8Array(buf));
      });
    }
  };

  const onClose = () => {
    const h = closeHandler;
    if (h) h();
  };

  conn.on("data", onData);
  conn.on("close", onClose);

  return bindBytesToPort({
    postChunk(bytes) {
      if (!conn.open) return;
      conn.send(bytes);
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
      conn.off("data", onData);
      conn.off("close", onClose);
      try {
        conn.close();
      } catch {
        // ignore
      }
    },
    mtu: options.mtu ?? DEFAULT_PEERJS_MTU,
  });
}

/**
 * Resolves to a `MessagePort` once the DataConnection reaches `open`. Rejects
 * if it closes first.
 */
export function createPeerJsPortAsync(
  conn: DataConnection,
  options: CreatePeerJsPortOptions = {},
): Promise<MessagePort> {
  if (conn.open) {
    return Promise.resolve(createPeerJsPort(conn, options));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      conn.off("open", onOpen);
      conn.off("close", onCloseEarly);
      conn.off("error", onErr);
    };
    const onOpen = () => {
      cleanup();
      resolve(createPeerJsPort(conn, options));
    };
    const onCloseEarly = () => {
      cleanup();
      reject(new Error("DataConnection closed before it opened"));
    };
    const onErr = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    conn.on("open", onOpen);
    conn.on("close", onCloseEarly);
    conn.on("error", onErr);
  });
}
