import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  defaultTimers,
  messageSize,
  postFrame,
  readFrame,
  type WsFrame,
  type WsTimers,
} from "./frames.js";

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export interface WsCloseEventInit extends EventInit {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

/**
 * A `CloseEvent` for runtimes that have none: Node 22 has `Event` and
 * `MessageEvent` as globals, but not `CloseEvent`.
 */
export class WsCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  constructor(type: string, init: WsCloseEventInit = {}) {
    super(type, init);
    this.code = init.code ?? 0;
    this.reason = init.reason ?? "";
    this.wasClean = init.wasClean ?? false;
  }
}

/** A `close` event: the platform's `CloseEvent` where there is one. */
export function newCloseEvent(init: WsCloseEventInit): Event {
  const Native = (globalThis as unknown as { CloseEvent?: typeof WsCloseEvent }).CloseEvent;
  return Native ? new Native("close", init) : new WsCloseEvent("close", init);
}

export interface PortSocketOptions {
  timers?: WsTimers;
  /** How long to wait for the echo of a close frame before giving up with 1006. */
  closeTimeoutMs?: number;
}

/**
 * What both ends of a socket over a `MessagePort` share: the frames, the close
 * handshake, and the byte accounting behind `bufferedAmount`.
 *
 * Not exported from the package: the two ends are `createWebSocketClass`'s
 * class and `ServerWebSocket`.
 */
export abstract class PortSocketCore extends EventTarget {
  protected _port?: MessagePort;
  protected _state: number = CONNECTING;
  protected readonly _timers: WsTimers;
  protected readonly _closeTimeoutMs: number;
  /** Bytes sent and not yet acknowledged by the peer, plus those still being prepared. */
  private _inFlight = 0;
  /** Bytes of messages "sent" after the socket started closing: counted, never sent. */
  private _discarded = 0;
  private _toAck = 0;
  private _ackScheduled = false;
  private _closeTimer: unknown;
  private _drainWaiters: Array<{ limit: number; resolve: () => void }> = [];

  constructor(options: PortSocketOptions = {}) {
    super();
    this._timers = options.timers ?? defaultTimers;
    this._closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  }

  get readyState(): number {
    return this._state;
  }

  /**
   * Bytes queued by `send()` that the peer has not consumed yet. A peer
   * acknowledges what it has dispatched, so this falls as the other side reads.
   */
  get bufferedAmount(): number {
    return this._inFlight + this._discarded;
  }

  /**
   * Resolves once `bufferedAmount` is at most `limit` (default 0), or the
   * socket is closed. The backpressure a producer applies:
   * `if (socket.bufferedAmount > HIGH) await socket.whenDrained(LOW)`.
   */
  whenDrained(limit = 0): Promise<void> {
    if (this._state === CLOSED || this._inFlight <= limit) return Promise.resolve();
    return new Promise((resolve) => this._drainWaiters.push({ limit, resolve }));
  }

  protected _attach(port: MessagePort): void {
    this._port = port;
    port.onmessage = (event) => {
      const frame = readFrame(event.data);
      if (frame) this._onFrame(frame);
    };
  }

  protected _onFrame(frame: WsFrame): void {
    switch (frame.t) {
      case "m":
      case "c":
        this._deliver(frame);
        return;
      case "a":
        this._inFlight = Math.max(0, this._inFlight - frame.n);
        this._wakeDrainWaiters();
        return;
      case "p":
        this._onPing(frame.hb);
        return;
      case "q":
        this._onPong();
        return;
    }
  }

  /** A message or close frame the socket is ready to act on. */
  protected _deliver(frame: Extract<WsFrame, { t: "m" | "c" }>): void {
    if (frame.t === "c") {
      this._onCloseFrame(frame.code, frame.reason);
      return;
    }
    if (this._state !== OPEN) return;
    this._dispatchMessage(frame.d);
    this._consumed(messageSize(frame.d));
  }

  protected abstract _dispatchMessage(data: string | ArrayBuffer): void;
  protected _onPing(_hb: number): void {}
  protected _onPong(): void {}
  protected _onClosed(): void {}

  /** Acknowledge consumed bytes, coalescing the acks of one turn into one frame. */
  protected _consumed(bytes: number): void {
    this._toAck += bytes;
    if (this._ackScheduled) return;
    this._ackScheduled = true;
    queueMicrotask(() => {
      this._ackScheduled = false;
      const n = this._toAck;
      this._toAck = 0;
      if (n > 0 && this._state !== CLOSED) this._post({ t: "a", n });
    });
  }

  /** Reserves `bytes` in `bufferedAmount` for a message still being prepared (a Blob). */
  protected _reserve(bytes: number): void {
    this._inFlight += bytes;
  }

  /** Sends one message whose bytes were reserved with `_reserve` (or `reserved = false`). */
  protected _sendData(data: string | ArrayBuffer, reserved = false): void {
    const size = messageSize(data);
    if (this._state !== OPEN) {
      if (reserved) this._inFlight = Math.max(0, this._inFlight - size);
      this._discarded += size;
      return;
    }
    if (!reserved) this._inFlight += size;
    this._post({ t: "m", d: data });
  }

  protected _post(frame: WsFrame): void {
    try {
      if (this._port) postFrame(this._port, frame);
    } catch {
      // The port is gone; the heartbeat notices.
    }
  }

  /** Starts the close handshake. */
  protected _startClose(code: number, reason: string): void {
    if (this._state === CLOSING || this._state === CLOSED) return;
    this._state = CLOSING;
    this._post({ t: "c", code, reason });
    this._closeTimer = this._timers.setTimeout(
      () => this._finish(1006, "", false),
      this._closeTimeoutMs,
    );
  }

  protected _onCloseFrame(code: number, reason: string): void {
    if (this._state === CLOSED) return;
    if (this._state === CLOSING) {
      // The echo of our own close.
      this._finish(code, reason, true);
      return;
    }
    this._state = CLOSING;
    this._post({ t: "c", code, reason });
    this._finish(code, reason, true);
  }

  /** The socket is closed: release the port and tell the listeners. */
  protected _finish(code: number, reason: string, wasClean: boolean, error = false): void {
    if (this._state === CLOSED) return;
    this._state = CLOSED;
    if (this._closeTimer !== undefined) this._timers.clearTimeout(this._closeTimer);
    this._closeTimer = undefined;
    this._onClosed();
    if (this._port) {
      this._port.onmessage = null;
      try {
        this._port.close();
      } catch {}
    }
    this._wakeDrainWaiters();
    if (error) this.dispatchEvent(new Event("error"));
    this.dispatchEvent(newCloseEvent({ code, reason, wasClean }));
  }

  private _wakeDrainWaiters(): void {
    if (this._drainWaiters.length === 0) return;
    const closed = this._state === CLOSED;
    this._drainWaiters = this._drainWaiters.filter(({ limit, resolve }) => {
      if (!closed && this._inFlight > limit) return true;
      resolve();
      return false;
    });
  }
}

/** Copies `data` into a fresh `ArrayBuffer`: `send()` must never detach the caller's buffer. */
export function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return copy.buffer;
}

export function isBinary(data: unknown): data is ArrayBuffer | ArrayBufferView {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

export function isBlob(data: unknown): data is Blob {
  return typeof Blob !== "undefined" && data instanceof Blob;
}

/** Valid close codes for an application to send: 1000, or 3000–4999. */
export function isApplicationCloseCode(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999);
}
