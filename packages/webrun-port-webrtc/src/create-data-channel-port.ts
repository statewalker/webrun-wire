import { bindBytesToPort } from "@statewalker/webrun-port-core";

/**
 * WebRTC DataChannel MTU is implementation-defined but typically ~256 KB on
 * desktop browsers and lower on older mobile stacks. Stay conservative — the
 * adaptive chunker in `webrun-port-core` handles anything above this.
 */
const DEFAULT_DC_MTU = 16 * 1024; // 16 KiB — safe across all current stacks

export interface CreateDataChannelPortOptions {
  /** Override the per-frame byte budget. Default ~16 KiB. */
  mtu?: number;
}

/**
 * Wrap an open `RTCDataChannel` into a real `MessagePort`. The DataChannel
 * must be in state `'open'` before calling this. Use
 * {@link createDataChannelPortAsync} if you hold a still-connecting channel.
 *
 * Signalling, peer connection, and DataChannel construction are the caller's
 * responsibility. This adapter takes over from the moment a DataChannel is
 * open.
 */
export function createDataChannelPort(
  channel: RTCDataChannel,
  options: CreateDataChannelPortOptions = {},
): MessagePort {
  if (channel.readyState !== "open") {
    throw new Error(`createDataChannelPort: channel is ${channel.readyState}, expected 'open'`);
  }
  // Ensure binary frames arrive as ArrayBuffer (default in browsers).
  channel.binaryType = "arraybuffer";

  let chunkHandler: ((bytes: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  const onMessage = (event: MessageEvent) => {
    if (!chunkHandler) return;
    const data = event.data as unknown;
    if (data instanceof ArrayBuffer) {
      chunkHandler(new Uint8Array(data));
      return;
    }
    if (data instanceof Uint8Array) {
      // Some polyfills (including @roamhq/wrtc in Node) deliver Uint8Array
      // directly even with binaryType="arraybuffer". Copy to detach from any
      // pooled buffer the polyfill may reuse.
      chunkHandler(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      chunkHandler(
        new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)),
      );
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => chunkHandler?.(new Uint8Array(buf)));
      return;
    }
    // string and other types are not part of the bridged contract; drop them.
  };

  const onClose = () => {
    closeHandler?.();
  };

  channel.addEventListener("message", onMessage);
  channel.addEventListener("close", onClose);

  return bindBytesToPort({
    postChunk(bytes) {
      if (channel.readyState !== "open") return;
      // Some implementations narrow `send` types; we know bytes is a Uint8Array
      // which the DataChannel accepts under both browser and polyfill stacks.
      (channel as unknown as { send: (data: ArrayBufferView) => void }).send(bytes);
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
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("close", onClose);
      try {
        channel.close();
      } catch {
        // ignore
      }
    },
    mtu: options.mtu ?? DEFAULT_DC_MTU,
  });
}

/**
 * Resolves to a `MessagePort` once the DataChannel reaches `open`. Rejects if
 * it reaches `closing` or `closed` first.
 */
export function createDataChannelPortAsync(
  channel: RTCDataChannel,
  options: CreateDataChannelPortOptions = {},
): Promise<MessagePort> {
  if (channel.readyState === "open") {
    return Promise.resolve(createDataChannelPort(channel, options));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onCloseEarly);
      channel.removeEventListener("error", onErr);
    };
    const onOpen = () => {
      cleanup();
      resolve(createDataChannelPort(channel, options));
    };
    const onCloseEarly = () => {
      cleanup();
      reject(new Error("DataChannel closed before it opened"));
    };
    const onErr = (ev: Event) => {
      cleanup();
      reject(
        new Error(
          `DataChannel error: ${(ev as unknown as { error?: { message?: string } }).error?.message ?? "unknown"}`,
        ),
      );
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onCloseEarly);
    channel.addEventListener("error", onErr);
  });
}
