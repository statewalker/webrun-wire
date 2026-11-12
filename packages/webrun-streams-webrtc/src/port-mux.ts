/** The label prefix of a port's data channel: channels without it are someone else's. */
export const PORT_LABEL_PREFIX = "webrun-port/";

/**
 * The largest message a data channel delivers between any two browsers (Firefox to Chrome cuts
 * off at 16 KiB). A post past it fails the port with a `RangeError` rather than vanishing.
 */
export const DEFAULT_PORT_MAX_FRAME_BYTES = 16 * 1024;

/** What one message on a port may carry before the stream tier chunks: 256 bytes under the frame limit (spec D10). */
export const DEFAULT_PORT_MAX_MESSAGE_SIZE = DEFAULT_PORT_MAX_FRAME_BYTES - 256;

/** `whenDrained` resolves once the channel's `bufferedAmount` is at most this. */
export const PORT_DRAIN_LOW_WATER = 256 * 1024;

/**
 * How a port's messages become bytes and back: any value the stream tier posts. `webrun-msgpack`'s
 * `{ encode: serialize, decode: deserialize }` fits.
 */
export interface ValueCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

type Listener = (event: MessageEvent) => void | Promise<void>;

/** One port: a data channel as a `MessageTarget` of values, with its close signal on it. */
export interface DataChannelPort {
  addEventListener(type: "message", listener: Listener): void;
  removeEventListener(type: "message", listener: Listener): void;
  /** Sends one message. `RangeError`, failing the port, past `maxFrameBytes`. */
  postMessage(message: unknown): void;
  close(): Promise<void>;
  readonly bufferedAmount: number;
  whenDrained(): Promise<void>;
  /** Aborts when the channel closes or errs, the connection fails, or the port is closed here. */
  readonly closeSignal: AbortSignal;
}

export interface WebRtcPortMuxOptions {
  /** A connected `RTCPeerConnection` with SCTP negotiated. Signalling is the caller's. */
  pc: RTCPeerConnection;
  /** Encodes each message; both ends must agree. */
  codec: ValueCodec;
  /** Called for each port the peer opens (an inbound channel with the port label). `false` refuses it. */
  onPort?: (port: DataChannelPort) => boolean | undefined;
  /** Reported as `maxMessageSize`. Default {@link DEFAULT_PORT_MAX_MESSAGE_SIZE}. */
  maxMessageSize?: number;
  /** Default {@link DEFAULT_PORT_MAX_FRAME_BYTES}. */
  maxFrameBytes?: number;
}

/** A `webrun-rpc` `PortMux` by shape; this package imports nothing from it. */
export interface WebRtcPortMux {
  openPort(meta?: unknown, options?: { signal?: AbortSignal }): Promise<DataChannelPort>;
  close(reason?: unknown): Promise<void>;
  readonly maxMessageSize: number;
}

let counter = 0;

/**
 * Native MessagePorts over WebRTC: every port is its own `RTCDataChannel` (ordered, reliable),
 * labelled `webrun-port/…`. Hand it to `webrun-rpc` as a port source and its stream tier runs one
 * call per port, with its backpressure: a producer stays one confirmed chunk ahead of its
 * consumer, where this package's `connect` / `serve` allow a 4 MiB window.
 *
 * ```ts
 * const codec = { encode: serialize, decode: deserialize }; // webrun-msgpack
 * await serve({ mux: overPorts((onPort) => webrtcPortMux({ pc, codec, onPort })) }, handler);
 * const { call } = await connect({ mux: overPorts(() => webrtcPortMux({ pc, codec })) });
 * ```
 *
 * Messages that arrive before a port's first listener are held for it.
 */
export async function webrtcPortMux(options: WebRtcPortMuxOptions): Promise<WebRtcPortMux> {
  const { pc, codec, onPort } = options;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_PORT_MAX_FRAME_BYTES;
  const maxMessageSize = options.maxMessageSize ?? DEFAULT_PORT_MAX_MESSAGE_SIZE;
  const live = new Set<DataChannelPort>();
  let closed = false;

  const connectionGone = new AbortController();
  const onConnectionState = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed")
      connectionGone.abort(
        new Error(`webrun-streams-webrtc: the connection is ${pc.connectionState}`),
      );
  };
  pc.addEventListener("connectionstatechange", onConnectionState);

  const wrap = (dc: RTCDataChannel): DataChannelPort => {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = PORT_DRAIN_LOW_WATER;
    const life = new AbortController();
    const end = (reason: Error) => {
      if (!life.signal.aborted) life.abort(reason);
    };
    const listeners = new Set<Listener>();
    let held: MessageEvent[] | undefined = [];
    const deliver = (data: unknown) => {
      const event = new MessageEvent("message", { data });
      for (const l of [...listeners]) {
        try {
          Promise.resolve(l(event)).catch(() => undefined);
        } catch {}
      }
    };
    const onMessage = (ev: MessageEvent) => {
      if (life.signal.aborted) return;
      let data: unknown;
      try {
        const raw = ev.data;
        data = codec.decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as Uint8Array));
      } catch (err) {
        end(
          new Error("webrun-streams-webrtc: a frame the port's codec cannot decode", {
            cause: err,
          }),
        );
        dc.close();
        return;
      }
      if (held) held.push(new MessageEvent("message", { data }));
      else deliver(data);
    };
    const onClose = () => end(new Error("webrun-streams-webrtc: the data channel closed"));
    const onError = (ev: Event) =>
      end(
        new Error(
          `webrun-streams-webrtc: the data channel failed: ${(ev as unknown as { error?: { message?: string } }).error?.message ?? "unknown"}`,
        ),
      );
    dc.addEventListener("message", onMessage);
    dc.addEventListener("close", onClose);
    dc.addEventListener("error", onError);
    const closeSignal = AbortSignal.any([life.signal, connectionGone.signal]);
    if (dc.readyState === "closing" || dc.readyState === "closed") onClose();
    closeSignal.addEventListener(
      "abort",
      () => {
        live.delete(port);
        dc.removeEventListener("message", onMessage);
        listeners.clear();
      },
      { once: true },
    );
    const port: DataChannelPort = {
      closeSignal,
      get bufferedAmount() {
        return dc.bufferedAmount;
      },
      whenDrained() {
        if (closeSignal.aborted || dc.bufferedAmount <= PORT_DRAIN_LOW_WATER)
          return Promise.resolve();
        return new Promise<void>((resolve) => {
          const done = () => {
            dc.removeEventListener("bufferedamountlow", done);
            closeSignal.removeEventListener("abort", done);
            resolve();
          };
          dc.addEventListener("bufferedamountlow", done);
          closeSignal.addEventListener("abort", done);
        });
      },
      postMessage(message) {
        if (closeSignal.aborted || dc.readyState !== "open") return; // `closeSignal` says so
        const bytes = codec.encode(message);
        if (bytes.byteLength > maxFrameBytes) {
          const err = new RangeError(
            `webrun-streams-webrtc: a ${bytes.byteLength}-byte message exceeds maxFrameBytes (${maxFrameBytes})`,
          );
          end(err);
          dc.close();
          throw err;
        }
        try {
          dc.send(bytes as Uint8Array<ArrayBuffer>);
        } catch (err) {
          // a send queue full, or a channel closing meanwhile: the port is broken
          end(err instanceof Error ? err : new Error(String(err)));
          dc.close();
        }
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
        if (held) {
          const pending = held;
          held = undefined;
          for (const ev of pending) deliver(ev.data);
        }
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
      async close() {
        end(new Error("webrun-streams-webrtc: port closed"));
        dc.close();
      },
    };
    live.add(port);
    return port;
  };

  const onChannel = (ev: RTCDataChannelEvent) => {
    const dc = ev.channel;
    if (!dc.label.startsWith(PORT_LABEL_PREFIX)) return; // someone else's channel
    if (closed || !onPort) {
      dc.close();
      return;
    }
    const port = wrap(dc);
    let accepted = false;
    try {
      accepted = onPort(port) !== false;
    } catch {
      accepted = false;
    }
    if (!accepted) void port.close();
  };
  pc.addEventListener("datachannel", onChannel);

  return {
    maxMessageSize,
    async openPort(_meta, opts) {
      if (closed) throw new Error("webrun-streams-webrtc: port mux closed");
      const dc = pc.createDataChannel(`${PORT_LABEL_PREFIX}${(counter++).toString(36)}`, {
        ordered: true,
      });
      const port = wrap(dc);
      await new Promise<void>((resolve, reject) => {
        if (dc.readyState === "open") return resolve();
        const done = () => {
          dc.removeEventListener("open", done);
          port.closeSignal.removeEventListener("abort", fail);
          resolve();
        };
        const fail = () => {
          dc.removeEventListener("open", done);
          reject(port.closeSignal.reason);
        };
        dc.addEventListener("open", done);
        port.closeSignal.addEventListener("abort", fail, { once: true });
      });
      const signal = opts?.signal;
      if (signal) {
        const onAbort = () => void port.close();
        signal.addEventListener("abort", onAbort, { once: true });
        port.closeSignal.addEventListener(
          "abort",
          () => signal.removeEventListener("abort", onAbort),
          {
            once: true,
          },
        );
      }
      return port;
    },
    async close() {
      if (closed) return;
      closed = true;
      pc.removeEventListener("datachannel", onChannel);
      pc.removeEventListener("connectionstatechange", onConnectionState);
      await Promise.allSettled([...live].map((p) => p.close()));
    },
  };
}
