import {
  DEFAULT_HEARTBEAT_MS,
  messageSize,
  postFrame,
  utf8Length,
  type WsFrame,
  type WsTimers,
} from "./frames.js";
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
  /** How long `close()` waits for the client's echo, in ms. Default 5 s; `Infinity` for ever. */
  closeTimeoutMs?: number;
  /**
   * When the heartbeat watch starts: `"open"` (the default) at once, so a client that never
   * pings is closed with 1006 after three default periods; `"first-ping"` with the client's
   * first ping, so a peer that does not ping at all (the other end of a pair kept in the same
   * realm, say) is never closed for it. Once pings have started, both close a socket whose
   * pings stop. Under `"first-ping"` a peer that never pings is never found dead.
   */
  watch?: "open" | "first-ping";
  /**
   * Which heartbeat period the watch keeps: `"follow"` (the default) the one each ping
   * announces, `"first"` the first ping's. A client announces a longer period when its page
   * turns hidden (browsers throttle hidden pages' timers), and a closing tab turns hidden on its
   * way out: following it notices a dead tab only after three of the longer periods.
   */
  heartbeatPeriod?: "follow" | "first";
  /** Lets `send()` before `accept()`; the frames wait in the port until the peer reads. */
  sendBeforeAccept?: boolean;
  /**
   * Delivers the messages that arrive after `close()` until the peer's close frame does (they
   * were in flight), as workerd does. By default they are dropped, as browsers do.
   */
  deliverWhileClosing?: boolean;
  /**
   * The code `close()` sends when given none. Default 1000. 1005 ("no status code") is what a
   * close frame without a code reads as on the other end, as `close()` does on workerd.
   */
  defaultCloseCode?: number;
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
 *   terminated worker), the socket closes with 1006. With `watch: "first-ping"`
 *   the watch starts only once the client pings.
 */
export class ServerWebSocket extends PortSocketCore {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readonly url: string;
  readonly protocol: string;
  private _binaryType: "blob" | "arraybuffer" = "arraybuffer";
  private readonly _options: ServerWebSocketOptions;
  private _accepted = false;
  private _detached = false;
  private _queue: Array<Extract<WsFrame, { t: "m" | "c" }>> = [];
  private _heartbeatMs = DEFAULT_HEARTBEAT_MS;
  private _lastPing = Date.now();
  /** Whether a ping (with a period a timer takes) arrived already. */
  private _pinged = false;
  private _watch: unknown;

  constructor(port: MessagePort, options: ServerWebSocketOptions = {}) {
    super({ timers: options.timers, closeTimeoutMs: options.closeTimeoutMs });
    this._options = options;
    this.url = options.url ?? "";
    this.protocol = options.protocol ?? "";
    this._attach(port);
    this._state = OPEN;
    if (options.watch !== "first-ping") this._watchHeartbeat();
  }

  /** Whether `accept()` was called. */
  get accepted(): boolean {
    return this._accepted;
  }

  /** How binary messages arrive: `ArrayBuffer`s (the default) or `Blob`s. Other values are ignored. */
  get binaryType(): "blob" | "arraybuffer" {
    return this._binaryType;
  }
  set binaryType(value: "blob" | "arraybuffer") {
    if (value === "blob" || value === "arraybuffer") this._binaryType = value;
  }

  /**
   * Hands this end's transport to another holder before it was accepted: the port to give the
   * client (a pair's end returned in a 101, say), with the frames that reached this end first
   * delivered ahead of the rest. This end is closed then, with no event, and answers nothing.
   */
  detach(): MessagePort {
    const port = this._port;
    if (!port || this._accepted || this._state !== OPEN) {
      throw new DOMException(
        "Only an open end that was not accepted can be detached.",
        "InvalidStateError",
      );
    }
    this._detached = true;
    this._port = undefined;
    port.onmessage = null;
    // Acks the peer still owes this end (it sent before being detached) are not the new
    // holder's to count: they are absorbed on the way.
    let owed = this.bufferedAmount;
    this._state = CLOSED;
    this._onClosed();
    this._wakeDrainWaiters();
    const queued = this._queue.splice(0);
    if (queued.length === 0 && owed === 0) return port;
    // The queued frames first, then the rest, both ways, through a channel of its own: frames
    // pass as they are (kinds this version does not know included), and the relay ends once
    // each way carried a close frame, or either port closes.
    const relay = new MessageChannel();
    const holder = relay.port2;
    const closing = new Set<"in" | "out">();
    const end = () => {
      port.onmessage = null;
      holder.onmessage = null;
      port.close();
      holder.close();
    };
    const sawClose = (way: "in" | "out") => {
      closing.add(way);
      if (closing.size === 2) end();
    };
    for (const frame of queued) {
      postFrame(holder, frame);
      if (frame.t === "c") closing.add("in");
    }
    holder.onmessage = (event) => {
      port.postMessage(event.data, transferables(event.data));
      if ((event.data as { t?: unknown } | null)?.t === "c") sawClose("out");
    };
    port.onmessage = (event) => {
      const data = event.data as { t?: unknown; n?: unknown } | null;
      if (data?.t === "a" && typeof data.n === "number" && owed > 0) {
        const absorbed = Math.min(owed, data.n);
        owed -= absorbed;
        if (data.n > absorbed) holder.postMessage({ t: "a", n: data.n - absorbed });
        return;
      }
      holder.postMessage(event.data, transferables(event.data));
      if (data?.t === "c") sawClose("in");
    };
    // A side that dies without a close frame: where the platform tells (MessagePort's "close").
    port.addEventListener?.("close", end);
    holder.addEventListener?.("close", end);
    return relay.port1;
  }

  /** Starts delivering events, the queued ones first. */
  accept(): void {
    if (this._detached) {
      throw new DOMException("This end was detached; it cannot be accepted.", "InvalidStateError");
    }
    if (this._accepted) return;
    this._accepted = true;
    for (const frame of this._queue.splice(0)) super._deliver(frame);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this._detached) {
      throw new DOMException("This end was detached; it cannot send.", "InvalidStateError");
    }
    if (!this._accepted && !this._options.sendBeforeAccept) {
      throw new DOMException("accept() the socket before sending on it.", "InvalidStateError");
    }
    this._sendData(isBinary(data) ? toArrayBuffer(data) : String(data));
  }

  close(code?: number, reason = ""): void {
    this.checkClose(code, reason);
    this._startClose(code ?? this._options.defaultCloseCode ?? 1000, reason);
  }

  /**
   * Refuses a `close()` the endpoint may not make: by default a code outside RFC 6455 §7.4's
   * sendable ones, or a reason over 123 bytes. A subclass with another platform's rules
   * overrides it.
   */
  protected checkClose(code: number | undefined, reason: string): void {
    if (code !== undefined && !isSendableCloseCode(code)) {
      throw new DOMException(
        `${code} is not a close code an endpoint may send.`,
        "InvalidAccessError",
      );
    }
    if (utf8Length(reason) > 123) {
      throw new DOMException("The close reason is longer than 123 bytes.", "SyntaxError");
    }
  }

  protected override _deliver(frame: Extract<WsFrame, { t: "m" | "c" }>): void {
    if (!this._accepted) {
      this._queue.push(frame);
      return;
    }
    if (frame.t === "m" && this._state === CLOSING && this._options.deliverWhileClosing) {
      this._dispatchMessage(frame.d);
      this._consumed(messageSize(frame.d));
      return;
    }
    super._deliver(frame);
  }

  protected _dispatchMessage(data: string | ArrayBuffer): void {
    const delivered =
      typeof data !== "string" && this._binaryType === "blob" ? new Blob([data]) : data;
    this.dispatchEvent(new MessageEvent("message", { data: delivered }));
  }

  protected override _onPing(hb: number): void {
    this._post({ t: "q" });
    this._lastPing = Date.now();
    if (this._state === CLOSED) return; // defensive: a closed socket's port receives nothing
    const keep = this._options.heartbeatPeriod === "first" && this._pinged;
    // A period no timer takes (2^31 - 1 ms and over: a client that turned its heartbeat off,
    // as cellb's does with `heartbeatMs: 0`) is no heartbeat at all: the watch stops, unless the
    // first period is the one kept.
    if (!(hb > 0 && hb < 2 ** 31 - 1)) {
      if (!keep && this._watch !== undefined) {
        this._timers.clearInterval(this._watch);
        this._watch = undefined;
      }
      return;
    }
    this._pinged = true;
    if (!keep && (this._watch === undefined || hb !== this._heartbeatMs)) {
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

/** The buffers a relayed frame carries, to transfer rather than copy. */
function transferables(data: unknown): Transferable[] {
  const d = (data as { d?: unknown } | null)?.d;
  return d instanceof ArrayBuffer ? [d] : [];
}
