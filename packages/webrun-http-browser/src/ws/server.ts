import { DEFAULT_HEARTBEAT_MS, utf8Length, type WsFrame, type WsTimers } from "./frames.js";
import {
  CLOSED,
  CLOSING,
  CONNECTING,
  isBinary,
  OPEN,
  PortSocketCore,
  toArrayBuffer,
} from "./socket-core.js";

export interface ServerWebSocketOptions {
  /** The url the client asked for. */
  url?: string;
  /** The subprotocol the server picked, `""` for none. */
  protocol?: string;
  timers?: WsTimers;
  /** How long `close()` waits for the client's echo, in ms. Default 5 s. */
  closeTimeoutMs?: number;
}

/**
 * The server end of a socket over a `MessagePort`: what a handler gets from
 * `upgradeWebSocket` and talks to.
 *
 * - Events are delivered only after `accept()`; frames that arrive earlier are
 *   queued. Pings are answered even before `accept()`, so a slow handler does
 *   not look like a dead one.
 * - Messages arrive as strings or `ArrayBuffer`s.
 * - `bufferedAmount` counts what the client has not consumed yet, and
 *   `whenDrained(limit)` waits for it to fall: the backpressure a producer
 *   applies.
 * - When the client's pings stop for three heartbeat periods (a closed tab, a
 *   terminated worker), the socket closes with 1006.
 */
export class ServerWebSocket extends PortSocketCore {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readonly url: string;
  readonly protocol: string;
  private _accepted = false;
  private _queue: Array<Extract<WsFrame, { t: "m" | "c" }>> = [];
  private _heartbeatMs = DEFAULT_HEARTBEAT_MS;
  private _lastPing = Date.now();
  private _watch: unknown;

  constructor(port: MessagePort, options: ServerWebSocketOptions = {}) {
    super({ timers: options.timers, closeTimeoutMs: options.closeTimeoutMs });
    this.url = options.url ?? "";
    this.protocol = options.protocol ?? "";
    this._attach(port);
    this._state = OPEN;
    this._watchHeartbeat();
  }

  /** Whether `accept()` was called. */
  get accepted(): boolean {
    return this._accepted;
  }

  /** Starts delivering events, the queued ones first. */
  accept(): void {
    if (this._accepted) return;
    this._accepted = true;
    for (const frame of this._queue.splice(0)) super._deliver(frame);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this._accepted) {
      throw new DOMException("accept() the socket before sending on it.", "InvalidStateError");
    }
    this._sendData(isBinary(data) ? toArrayBuffer(data) : String(data));
  }

  close(code = 1000, reason = ""): void {
    if (!isSendableCloseCode(code)) {
      throw new DOMException(
        `${code} is not a close code an endpoint may send.`,
        "InvalidAccessError",
      );
    }
    if (utf8Length(reason) > 123) {
      throw new DOMException("The close reason is longer than 123 bytes.", "SyntaxError");
    }
    this._startClose(code, reason);
  }

  protected override _deliver(frame: Extract<WsFrame, { t: "m" | "c" }>): void {
    if (!this._accepted) {
      this._queue.push(frame);
      return;
    }
    super._deliver(frame);
  }

  protected _dispatchMessage(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  protected override _onPing(hb: number): void {
    this._post({ t: "q" });
    this._lastPing = Date.now();
    if (hb !== this._heartbeatMs) {
      this._heartbeatMs = hb;
      this._watchHeartbeat();
    }
  }

  protected override _onClosed(): void {
    if (this._watch !== undefined) this._timers.clearInterval(this._watch);
    this._watch = undefined;
  }

  private _watchHeartbeat(): void {
    if (this._watch !== undefined) this._timers.clearInterval(this._watch);
    this._watch = this._timers.setInterval(() => {
      if (Date.now() - this._lastPing > 3 * this._heartbeatMs) {
        this._finish(1006, "", false, true);
      }
    }, this._heartbeatMs);
  }
}

/** Codes an endpoint may put in a close frame (RFC 6455 §7.4). */
function isSendableCloseCode(code: number): boolean {
  if (!Number.isInteger(code)) return false;
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}
