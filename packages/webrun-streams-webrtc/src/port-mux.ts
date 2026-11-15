import {
  type NativePort,
  newMessagePipe,
  newNativePortMux,
  type ValueCodec,
} from "@statewalker/webrun-streams";

export type { ValueCodec };

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
 * One port: a data channel as a `MessageTarget` of values, with its close signal on it. Built by
 * the shared native port lifecycle (`newNativePortMux` in `@statewalker/webrun-streams`). A post
 * past `maxFrameBytes` throws `RangeError` and fails the port.
 */
export type DataChannelPort = NativePort;

export interface WebRtcPortMuxOptions {
  /** A connected `RTCPeerConnection` with SCTP negotiated. Signalling is the caller's. */
  pc: RTCPeerConnection;
  /** Encodes each message; both ends must agree. */
  codec: ValueCodec;
  /**
   * Called for each port the peer opens (an inbound channel with the port label). `false` refuses
   * it. A mux without `onPort` (a caller's) ignores inbound ports, leaving them to the serving
   * mux on the same connection; of several serving muxes on one connection, the first takes each.
   */
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
/** Inbound port channels a serving mux has taken: on one connection, each port is answered once. */
const claimed = new WeakSet<RTCDataChannel>();

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
 * Messages that arrive before a port's first listener are held for it and delivered after that
 * tick, to every listener added by then. Messages posted before a port's channel opens are queued
 * and sent, in order, when it opens.
 */
export async function webrtcPortMux(options: WebRtcPortMuxOptions): Promise<WebRtcPortMux> {
  const { pc, codec, onPort } = options;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_PORT_MAX_FRAME_BYTES;
  const maxMessageSize = options.maxMessageSize ?? DEFAULT_PORT_MAX_MESSAGE_SIZE;

  const connectionGone = new AbortController();
  const onConnectionState = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed")
      connectionGone.abort(
        new Error(`webrun-streams-webrtc: the connection is ${pc.connectionState}`),
      );
  };
  pc.addEventListener("connectionstatechange", onConnectionState);
  onConnectionState(); // a connection that has failed already

  /** A data channel's bytes as a pipe. */
  const pipeOf = (dc: RTCDataChannel) => {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = PORT_DRAIN_LOW_WATER;
    // Posts made while the channel is still connecting, sent in order when it opens, as a
    // MessagePort queues them (statewalker/statewalker-root#57). `undefined` once the channel has
    // opened, or when it was open already.
    let queued: Uint8Array[] | undefined = dc.readyState === "connecting" ? [] : undefined;
    const sendNow = (bytes: Uint8Array) => {
      try {
        dc.send(bytes as Uint8Array<ArrayBuffer>);
      } catch (err) {
        // a send queue full, or a channel closing meanwhile: the port is broken
        control.end(err instanceof Error ? err : new Error(String(err)), true);
      }
    };
    const onMessage = (ev: MessageEvent) => control.deliver(ev.data);
    const onOpen = () => {
      const pending = queued;
      queued = undefined;
      for (const bytes of pending ?? []) {
        if (control.ended) return;
        sendNow(bytes);
      }
    };
    const onClose = () => control.end(new Error("webrun-streams-webrtc: the data channel closed"));
    const onError = (ev: Event) =>
      control.end(
        new Error(
          `webrun-streams-webrtc: the data channel failed: ${(ev as unknown as { error?: { message?: string } }).error?.message ?? "unknown"}`,
        ),
      );
    const control = newMessagePipe(
      {
        send: (bytes) => {
          if (queued) queued.push(bytes);
          else sendNow(bytes);
        },
        // a channel closing or closed: its close event ends the pipe
        canSend: () => !!queued || dc.readyState === "open",
        bufferedAmount: () => dc.bufferedAmount,
        whenDrained: () =>
          new Promise<void>((resolve) =>
            dc.addEventListener("bufferedamountlow", () => resolve(), { once: true }),
          ),
        close: () => {
          dc.removeEventListener("message", onMessage);
          dc.removeEventListener("open", onOpen);
          dc.removeEventListener("close", onClose);
          dc.removeEventListener("error", onError);
          queued = undefined;
          if (dc.readyState !== "closed") dc.close();
        },
      },
      { name: "webrun-streams-webrtc", maxFrameBytes, drainLowWater: PORT_DRAIN_LOW_WATER },
    );
    dc.addEventListener("message", onMessage);
    dc.addEventListener("open", onOpen);
    dc.addEventListener("close", onClose);
    dc.addEventListener("error", onError);
    if (dc.readyState === "closing" || dc.readyState === "closed") onClose();
    return control.pipe.target;
  };

  const ports = newNativePortMux({
    name: "webrun-streams-webrtc",
    codec,
    maxMessageSize,
    onPort: onPort ? (port) => onPort(port) : undefined,
    connectionSignal: connectionGone.signal,
    async open(signal) {
      const dc = pc.createDataChannel(`${PORT_LABEL_PREFIX}${(counter++).toString(36)}`, {
        ordered: true,
      });
      const pipe = pipeOf(dc);
      const gone = AbortSignal.any([pipe.closeSignal, connectionGone.signal]);
      await new Promise<void>((resolve, reject) => {
        if (gone.aborted) {
          void pipe.close();
          return reject(gone.reason);
        }
        if (dc.readyState === "open") return resolve();
        const settle = () => {
          dc.removeEventListener("open", done);
          gone.removeEventListener("abort", fail);
          signal?.removeEventListener("abort", cancel);
        };
        const done = () => {
          settle();
          resolve();
        };
        const fail = () => {
          settle();
          void pipe.close();
          reject(gone.reason);
        };
        const cancel = () => {
          settle();
          void pipe.close();
          reject(signal?.reason);
        };
        dc.addEventListener("open", done);
        gone.addEventListener("abort", fail, { once: true });
        signal?.addEventListener("abort", cancel, { once: true });
      });
      return { pipe };
    },
    stopAccepting() {
      pc.removeEventListener("datachannel", onChannel);
      pc.removeEventListener("connectionstatechange", onConnectionState);
    },
  });

  const onChannel = (ev: RTCDataChannelEvent) => {
    const dc = ev.channel;
    if (!dc.label.startsWith(PORT_LABEL_PREFIX)) return; // someone else's channel
    // A mux that accepts no ports (a caller's) leaves inbound ports to the serving mux on the
    // same connection; of several serving muxes, the first takes each port.
    if (!onPort || ports.closed || claimed.has(dc)) return;
    claimed.add(dc);
    ports.accept({ pipe: pipeOf(dc) }, undefined);
  };
  pc.addEventListener("datachannel", onChannel);

  return ports.mux as WebRtcPortMux;
}
