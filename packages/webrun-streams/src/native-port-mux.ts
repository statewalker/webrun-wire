/**
 * The lifecycle of native ports: a port source for a transport that opens a
 * channel per port (a WebRTC data channel, a libp2p stream), shaped as
 * `@statewalker/webrun-rpc`'s `PortMux`.
 *
 * Both native transports need the same lifecycle: a codec over each channel's
 * bytes, messages held until a port's first listener, a close signal that
 * also aborts when the whole connection goes, accept-or-refuse of inbound
 * ports, the caller's signal bound to the port it opened, and close-all. This
 * module owns it, so a port-lifecycle bug is fixed once for both; a transport
 * supplies only "open a channel", "an inbound channel arrived" and the
 * channel's bytes as a pipe (statewalker/webrun-wire#152). A port is a pipe
 * with a codec: the channel is a byte pipe, as `newMessagePipe` builds one.
 */

import type { MessagePipeListener } from "./message-pipe.js";

/**
 * How a port's messages become bytes and back: any value the stream tier
 * posts. `webrun-msgpack`'s `{ encode: serialize, decode: deserialize }` fits.
 */
export interface ValueCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

/** One channel's bytes: a `MessageTarget` of `Uint8Array`s with its life on it. */
export interface BytePipeTarget {
  addEventListener(type: "message", listener: MessagePipeListener): void;
  removeEventListener(type: "message", listener: MessagePipeListener): void;
  postMessage(message: unknown): void;
  close(): Promise<void>;
  readonly bufferedAmount: number;
  whenDrained(): Promise<void>;
  /** Aborts when the channel is over. */
  readonly closeSignal: AbortSignal;
}

/** A channel a transport opened or received. */
export interface NativeChannel {
  /** The channel's bytes. */
  pipe: BytePipeTarget;
  /**
   * Resolves once the channel carries messages, for a channel `open` hands
   * back while it is still opening (a WebRTC data channel). The port is
   * built first, so what the peer sends meanwhile is held for it; `openPort`
   * resolves once this does, and rejects (closing the port) if it rejects.
   * It should reject when `open`'s signal aborts; `openPort` rejects anyway
   * once the port ends (the mux closing, the connection going).
   */
  ready?: Promise<void>;
  /**
   * Ends the channel because this side broke it off: a port refused, a frame
   * the codec cannot decode. A transport that can tell its peer (a libp2p
   * stream reset) does so here. Default: `pipe.close()`.
   */
  fail?(reason: Error): void;
}

/** One port: a channel as a `MessageTarget` of values, with its close signal on it. */
export interface NativePort {
  addEventListener(type: "message", listener: MessagePipeListener): void;
  removeEventListener(type: "message", listener: MessagePipeListener): void;
  /** Sends one message, encoded. Whatever the channel throws (a frame ceiling) fails the port. */
  postMessage(message: unknown): void;
  close(): Promise<void>;
  readonly bufferedAmount: number;
  whenDrained(): Promise<void>;
  /** Aborts when the channel ends, the connection goes, or the port is closed here. */
  readonly closeSignal: AbortSignal;
}

/** A `webrun-rpc` `PortMux` by shape. */
export interface NativePortMux<Port extends NativePort = NativePort> {
  openPort(meta?: unknown, options?: { signal?: AbortSignal }): Promise<Port>;
  close(reason?: unknown): Promise<void>;
  readonly maxMessageSize: number;
}

export interface NativePortMuxOptions<Info> {
  /** Prefix of the errors the mux raises, e.g. `"webrun-streams-webrtc"`. */
  name: string;
  /** Encodes each message; both ends must agree. */
  codec: ValueCodec;
  /** Reported as `maxMessageSize`. */
  maxMessageSize: number;
  /**
   * Called for each port the peer opens. `false`, or a throw, refuses it:
   * its channel fails. Without it the mux accepts none.
   */
  onPort?: (port: NativePort, info: Info) => boolean | undefined;
  /** Aborts when the whole connection is gone: every port fails, and `openPort` rejects. */
  connectionSignal?: AbortSignal;
  /**
   * Opens a channel to the peer, resolving once it carries messages (or once
   * it queues them). Rejects with `signal`'s reason when it aborts first; the
   * signal aborts for the caller's signal, the connection going, or the mux
   * closing.
   */
  open(signal?: AbortSignal): Promise<NativeChannel>;
  /** Stops the transport offering inbound channels; runs once, on `close()`. */
  stopAccepting?(): void | Promise<void>;
}

/** What `newNativePortMux` hands back: the mux, and where the transport reports inbound channels. */
export interface NativePortMuxControl<I = unknown> {
  mux: NativePortMux;
  /**
   * An inbound channel arrived, with what the transport knows of it. The port
   * is built at once, in this tick, so nothing that arrives is lost; it is
   * handed to `onPort`, or failed if the mux accepts none, is closed, or
   * `onPort` refuses it.
   */
  accept(channel: NativeChannel, info: I): void;
  /** Whether `close()` has run. */
  readonly closed: boolean;
}

/** Builds a native port mux; see {@link NativePortMuxOptions}. */
export function newNativePortMux<I = unknown>(
  options: NativePortMuxOptions<I>,
): NativePortMuxControl<I> {
  const { name, codec, maxMessageSize, onPort, connectionSignal } = options;
  const live = new Set<NativePort>();
  let closed = false;
  /** Aborts on `close()`: a channel still opening is given up, and its `openPort` rejects. */
  const closing = new AbortController();

  const wrap = (channel: NativeChannel): { port: NativePort; fail(reason: Error): void } => {
    const { pipe } = channel;
    const local = new AbortController();
    const signals = [pipe.closeSignal, local.signal];
    if (connectionSignal) signals.push(connectionSignal);
    const closeSignal = AbortSignal.any(signals);
    const listeners = new Set<MessagePipeListener>();
    // Messages that arrive before the first listener: held for it, then
    // delivered after that tick, as a MessagePort dispatches its queue.
    let held: unknown[] | undefined = [];
    const deliver = (data: unknown): void => {
      if (closeSignal.aborted) return;
      const event = new MessageEvent("message", { data });
      for (const listener of [...listeners]) {
        try {
          Promise.resolve(listener(event)).catch(() => undefined);
        } catch {}
      }
    };
    /** Set once the channel was broken off: it must not also be closed gracefully. */
    let failedHard = false;
    const fail = (reason: Error): void => {
      // The channel's own failure first (a libp2p reset): aborting `local`
      // runs `cleanUp`, whose graceful close would otherwise go out before it,
      // and the peer could see a normal end instead of a refusal.
      if (channel.fail) {
        failedHard = true;
        try {
          channel.fail(reason);
        } catch {}
      }
      if (!local.signal.aborted) local.abort(reason);
      if (!channel.fail) void pipe.close().catch(() => undefined);
    };
    const onBytes = (event: MessageEvent): void => {
      if (closeSignal.aborted) return;
      let data: unknown;
      try {
        data = codec.decode(event.data as Uint8Array);
      } catch (err) {
        // A peer speaking another codec, or a corrupt frame: fail the port
        // rather than drop the message and leave its call waiting.
        fail(new Error(`${name}: a frame the port's codec cannot decode`, { cause: err }));
        return;
      }
      if (held) held.push(data);
      else deliver(data);
    };
    pipe.addEventListener("message", onBytes);
    const cleanUp = (): void => {
      live.delete(port);
      pipe.removeEventListener("message", onBytes);
      listeners.clear();
      held = undefined;
      if (!failedHard) void pipe.close().catch(() => undefined);
    };
    const port: NativePort = {
      closeSignal,
      get bufferedAmount() {
        return pipe.bufferedAmount;
      },
      whenDrained: () => (closeSignal.aborted ? Promise.resolve() : pipe.whenDrained()),
      postMessage(message) {
        if (closeSignal.aborted) return; // `closeSignal` says so
        const bytes = codec.encode(message);
        try {
          pipe.postMessage(bytes);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (!local.signal.aborted) local.abort(error);
          throw error;
        }
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
        if (held) {
          // Every listener added in this tick (the stream tier adds two in a
          // row) gets the held messages.
          const pending = held;
          held = undefined;
          queueMicrotask(() => {
            for (const data of pending) deliver(data);
          });
        }
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
      async close() {
        if (!local.signal.aborted) local.abort(new Error(`${name}: port closed`));
        await pipe.close().catch(() => undefined);
      },
    };
    live.add(port);
    // A channel or connection gone already: an abort listener would never fire.
    if (closeSignal.aborted) cleanUp();
    else closeSignal.addEventListener("abort", cleanUp, { once: true });
    return { port, fail };
  };

  const mux: NativePortMux = {
    maxMessageSize,
    async openPort(_meta, opts) {
      if (closed) throw new Error(`${name}: port mux closed`);
      const signal = opts?.signal;
      signal?.throwIfAborted();
      if (connectionSignal?.aborted) throw connectionSignal.reason;
      const opening = [closing.signal];
      if (signal) opening.push(signal);
      if (connectionSignal) opening.push(connectionSignal);
      const openSignal = AbortSignal.any(opening);
      let channel: NativeChannel;
      try {
        channel = await options.open(openSignal);
      } catch (err) {
        // Given up because the mux closed meanwhile: say so, as `openPort` on a closed mux does.
        if (closing.signal.aborted && !signal?.aborted) {
          throw new Error(`${name}: port mux closed`, { cause: err });
        }
        throw err;
      }
      // Handled from here on: a `ready` that rejects while this function is
      // not awaiting it (the mux closing in this very tick) is no unhandled rejection.
      channel.ready?.catch(() => undefined);
      if (closed) {
        await channel.pipe.close().catch(() => undefined);
        throw new Error(`${name}: port mux closed`);
      }
      const { port } = wrap(channel);
      if (channel.ready) {
        const { ready } = channel;
        try {
          // Raced against the port's own end: a `ready` that does not watch
          // the open signal must not hand back a port the mux already closed.
          await new Promise<void>((resolve, reject) => {
            const onEnd = () => reject(port.closeSignal.reason);
            if (port.closeSignal.aborted) return onEnd();
            port.closeSignal.addEventListener("abort", onEnd, { once: true });
            ready.then(
              () => {
                port.closeSignal.removeEventListener("abort", onEnd);
                resolve();
              },
              (err: unknown) => {
                port.closeSignal.removeEventListener("abort", onEnd);
                reject(err);
              },
            );
          });
        } catch (err) {
          void port.close();
          if (closing.signal.aborted && !signal?.aborted) {
            throw new Error(`${name}: port mux closed`, { cause: err });
          }
          throw err;
        }
      }
      // The mux closed in the microtasks since: reject as `openPort` on a
      // closed mux does. (A port whose channel already ended is handed back
      // as before: its `closeSignal` says why.)
      if (closed) {
        void port.close();
        throw new Error(`${name}: port mux closed`);
      }
      if (signal) {
        const onAbort = () => void port.close();
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        // The caller's signal may outlive many ports: let go of this one when it closes.
        port.closeSignal.addEventListener(
          "abort",
          () => signal.removeEventListener("abort", onAbort),
          { once: true },
        );
      }
      return port;
    },
    async close() {
      if (closed) return;
      closed = true;
      closing.abort(new Error(`${name}: port mux closed`));
      try {
        await options.stopAccepting?.();
      } catch {}
      await Promise.allSettled([...live].map((p) => p.close()));
    },
  };

  return {
    mux,
    accept(channel, info) {
      // Built in this tick, before anything else runs: the channel may
      // already be delivering, and a message with no reader would be lost.
      const { port, fail } = wrap(channel);
      let accepted = false;
      if (onPort && !closed) {
        try {
          accepted = onPort(port, info) !== false;
        } catch {
          accepted = false;
        }
      }
      if (!accepted) fail(new Error(`${name}: port refused`));
    },
    get closed() {
      return closed;
    },
  };
}
