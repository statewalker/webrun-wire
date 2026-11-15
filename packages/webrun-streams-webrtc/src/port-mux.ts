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

/**
 * The `protocol` of a windowed port's data channel: a mux with `window` opens
 * its ports' channels with it, and a serving mux with `window` that sees it
 * answers with its window (statewalker/webrun-wire#153).
 */
export const WINDOW_CHANNEL_PROTOCOL = "webrun-port-window/1";

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
  /**
   * Per-port flow control, in bytes (off when unset; from 64 KiB): the most this end holds
   * of a port's messages delivered and not yet consumed
   * (statewalker/webrun-wire#153). A port whose two ends both set it agrees
   * the window over its data channel ({@link WINDOW_CHANNEL_PROTOCOL}, then
   * the serving end's hello), and `webrun-rpc`'s stream tier then pipelines
   * its chunks, up to the peer's window in flight, instead of waiting for
   * each chunk's confirmation; against a mux without it (an older peer) the
   * port runs as before. Keep it well under the browser's data channel send
   * buffer (16 MiB in Chromium, which closes a channel that overflows it):
   * 1-4 MiB is a reasonable range.
   *
   * A windowed port never runs further ahead than min(the peer's window,
   * this window), and sends nothing while its channel holds more than
   * {@link PORT_DRAIN_LOW_WATER} (statewalker/webrun-wire#195).
   */
  window?: number;
  /**
   * How long, in ms, a write on a windowed port may wait for its data channel
   * to drain (a peer that stopped reading) before the channel is closed and
   * the port fails. Only a write blocked on drain counts: a quiet port is
   * never timed out. Default {@link DEFAULT_PORT_DRAIN_TIMEOUT_MS} (5 minutes);
   * 0 or `Infinity`: no bound.
   *
   * Windowed ports hold data while the channel's `bufferedAmount` is above
   * {@link PORT_DRAIN_LOW_WATER} (256 KiB), which may lower throughput on
   * links with a large bandwidth-delay product (unmeasured; statewalker/webrun-wire#189).
   */
  drainTimeoutMs?: number;
}

/** 5 minutes: how long a write on a windowed port waits for its channel to drain by default. */
export const DEFAULT_PORT_DRAIN_TIMEOUT_MS = 300_000;

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
  const { pc, codec, onPort, window } = options;
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
    window,
    drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_PORT_DRAIN_TIMEOUT_MS,
    async open(signal) {
      const dc = pc.createDataChannel(`${PORT_LABEL_PREFIX}${(counter++).toString(36)}`, {
        ordered: true,
        ...(window !== undefined ? { protocol: WINDOW_CHANNEL_PROTOCOL } : {}),
      });
      const pipe = pipeOf(dc);
      const gone = AbortSignal.any([pipe.closeSignal, connectionGone.signal]);
      // Handed back at once, with `ready`: the port is built (and listening)
      // before the channel opens, so what the peer sends as soon as it sees the
      // channel is held for it rather than lost.
      const ready = new Promise<void>((resolve, reject) => {
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
      // Asked, not agreed: only the serving end's hello says it speaks the window.
      return { pipe, ready, ...(window !== undefined ? { window: "offered" as const } : {}) };
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
    // The opener asked for the window: this end, with one, agrees and says hello at once.
    const windowed = window !== undefined && dc.protocol === WINDOW_CHANNEL_PROTOCOL;
    ports.accept(
      { pipe: pipeOf(dc), ...(windowed ? { window: "agreed" as const } : {}) },
      undefined,
    );
  };
  pc.addEventListener("datachannel", onChannel);

  return ports.mux as WebRtcPortMux;
}
