import { DEFAULT_HEARTBEAT_MS, utf8Length, type WsTimers } from "./frames.js";
import {
  CLOSED,
  CLOSING,
  CONNECTING,
  isApplicationCloseCode,
  isBinary,
  isBlob,
  OPEN,
  PortSocketCore,
  toArrayBuffer,
} from "./socket-core.js";

/** What `connect` gives a socket once the server accepted it (the 101). */
export interface WebSocketConnection {
  port: MessagePort;
  /** The subprotocol the server picked, `""` for none. */
  protocol: string;
}

/**
 * Opens the transport of one socket: resolves once the server accepted the
 * upgrade, rejects when it refused or could not be reached. Where the port
 * comes from — a ServiceWorker, a relay, a handler in the same page — is the
 * caller's business.
 */
export type WebSocketConnector = (url: string, protocols: string[]) => Promise<WebSocketConnection>;

export interface WebSocketClassOptions {
  /** Ping period, in ms. Pongs missing for twice that close the socket with 1006. Default 10 s. */
  heartbeatMs?: number;
  /** Timer functions; see `WsTimers`. */
  timers?: WsTimers;
  /** How long `close()` waits for the server's echo, in ms. Default 5 s. */
  closeTimeoutMs?: number;
}

type Listener = ((event: Event) => void) | null;

/** The instance side of the class `createWebSocketClass` returns: the WHATWG `WebSocket` surface. */
export interface PortWebSocket extends EventTarget {
  readonly url: string;
  readonly protocol: string;
  readonly extensions: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: Listener;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: Listener;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  /** Not in the standard: see `PortSocketCore.whenDrained`. */
  whenDrained(limit?: number): Promise<void>;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

export interface PortWebSocketClass {
  new (url: string | URL, protocols?: string | string[]): PortWebSocket;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

/** RFC 7230 `token`: what a subprotocol name may be. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A WHATWG-compatible `WebSocket` class whose transport is a `MessagePort`
 * from `connect`. Code written against the browser's `WebSocket` runs on it
 * unchanged:
 *
 * ```ts
 * const WS = createWebSocketClass(adapter.connectWebSocket);
 * const ws = new WS(`${baseUrl}chat`, ["v1"]);
 * ws.onmessage = (event) => console.log(event.data);
 * ```
 *
 * It validates as the standard does (url, scheme, fragment, subprotocol
 * tokens and duplicates, close codes and reasons), has `binaryType`, the `on*`
 * handlers next to `addEventListener`, and the close handshake.
 * `bufferedAmount` is real: the server acknowledges what it consumed.
 *
 * The real `globalThis.WebSocket` is left alone; install the class where you
 * want it.
 */
export function createWebSocketClass(
  connect: WebSocketConnector,
  options: WebSocketClassOptions = {},
): PortWebSocketClass {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  class WebSocketOverPort extends PortSocketCore implements PortWebSocket {
    static readonly CONNECTING = CONNECTING as 0;
    static readonly OPEN = OPEN as 1;
    static readonly CLOSING = CLOSING as 2;
    static readonly CLOSED = CLOSED as 3;
    readonly CONNECTING = CONNECTING as 0;
    readonly OPEN = OPEN as 1;
    readonly CLOSING = CLOSING as 2;
    readonly CLOSED = CLOSED as 3;

    readonly url: string;
    readonly extensions = "";
    private _protocol = "";
    private _binaryType: BinaryType = "blob";
    private _handlers: Record<string, Listener> = {};
    private _heartbeat: unknown;
    private _lastPong = 0;
    /** Sends waiting for a Blob ahead of them to be read, so order is kept. */
    private _chain?: Promise<void>;

    constructor(url: string | URL, protocols: string | string[] = []) {
      super({ timers: options.timers, closeTimeoutMs: options.closeTimeoutMs });
      this.url = parseUrl(url);
      const list = typeof protocols === "string" ? [protocols] : [...protocols];
      validateProtocols(list);
      for (const type of ["open", "message", "error", "close"]) {
        this.addEventListener(type, (event) => this._handlers[type]?.call(this, event));
      }
      // Asynchronously, as the platform does: listeners added right after the
      // constructor must still see `open` or `error`.
      Promise.resolve()
        .then(() => connect(this.url, list))
        .then(
          (connection) => this._opened(connection, list),
          () => this._failed(),
        );
    }

    get protocol(): string {
      return this._protocol;
    }

    get binaryType(): BinaryType {
      return this._binaryType;
    }
    set binaryType(value: BinaryType) {
      // The standard ignores values it does not know.
      if (value === "blob" || value === "arraybuffer") this._binaryType = value;
    }

    get onopen(): Listener {
      return this._handlers.open ?? null;
    }
    set onopen(fn: Listener) {
      this._handlers.open = typeof fn === "function" ? fn : null;
    }
    get onmessage(): ((event: MessageEvent) => void) | null {
      return (this._handlers.message as (event: MessageEvent) => void) ?? null;
    }
    set onmessage(fn: ((event: MessageEvent) => void) | null) {
      this._handlers.message = typeof fn === "function" ? (fn as Listener) : null;
    }
    get onerror(): Listener {
      return this._handlers.error ?? null;
    }
    set onerror(fn: Listener) {
      this._handlers.error = typeof fn === "function" ? fn : null;
    }
    get onclose(): ((event: CloseEvent) => void) | null {
      return (this._handlers.close as (event: CloseEvent) => void) ?? null;
    }
    set onclose(fn: ((event: CloseEvent) => void) | null) {
      this._handlers.close = typeof fn === "function" ? (fn as Listener) : null;
    }

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      if (this._state === CONNECTING) {
        throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      }
      if (isBlob(data)) {
        const size = data.size;
        if (this._state !== OPEN) {
          this._sendData(new ArrayBuffer(size));
          return;
        }
        this._reserve(size);
        this._enqueue(async () => this._sendData(await data.arrayBuffer(), true));
        return;
      }
      const payload = isBinary(data) ? toArrayBuffer(data) : String(data);
      if (this._chain) this._enqueue(async () => this._sendData(payload));
      else this._sendData(payload);
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && !isApplicationCloseCode(code)) {
        throw new DOMException(
          `The close code must be 1000 or in 3000-4999; ${code} is neither.`,
          "InvalidAccessError",
        );
      }
      const text = reason ?? "";
      if (utf8Length(text) > 123) {
        throw new DOMException("The close reason is longer than 123 bytes.", "SyntaxError");
      }
      if (this._state === CLOSING || this._state === CLOSED) return;
      if (this._state === CONNECTING) {
        // Fail the connection: `_opened` sees CLOSING and lets the port go.
        this._state = CLOSING;
        return;
      }
      this._startClose(code ?? 1005, text);
    }

    protected _dispatchMessage(data: string | ArrayBuffer): void {
      const value =
        typeof data === "string" || this._binaryType === "arraybuffer" ? data : new Blob([data]);
      this.dispatchEvent(
        new MessageEvent("message", { data: value, origin: new URL(this.url).origin }),
      );
    }

    protected _onPong(): void {
      this._lastPong = Date.now();
    }

    protected _onClosed(): void {
      if (this._heartbeat !== undefined) this._timers.clearInterval(this._heartbeat);
      this._heartbeat = undefined;
    }

    private _opened(connection: WebSocketConnection, requested: string[]): void {
      const { port, protocol = "" } = connection;
      if (this._state !== CONNECTING) {
        // Closed while connecting.
        try {
          port.postMessage({ t: "c", code: 1006, reason: "" });
          port.close();
        } catch {}
        this._finish(1006, "", false, true);
        return;
      }
      if (protocol !== "" && !requested.includes(protocol)) {
        port.close();
        this._failed();
        return;
      }
      this._protocol = protocol;
      this._attach(port);
      this._state = OPEN;
      this._lastPong = Date.now();
      this._post({ t: "p", hb: heartbeatMs });
      this._heartbeat = this._timers.setInterval(() => {
        if (Date.now() - this._lastPong > 2 * heartbeatMs) {
          this._finish(1006, "", false, true);
          return;
        }
        this._post({ t: "p", hb: heartbeatMs });
      }, heartbeatMs);
      this.dispatchEvent(new Event("open"));
    }

    private _failed(): void {
      this._state = CLOSING;
      this._finish(1006, "", false, true);
    }

    private _enqueue(task: () => Promise<void>): void {
      const run = (this._chain ?? Promise.resolve()).then(task).catch(() => {});
      this._chain = run;
      void run.then(() => {
        if (this._chain === run) this._chain = undefined;
      });
    }
  }

  return WebSocketOverPort;
}

function parseUrl(input: string | URL): string {
  let url: URL;
  try {
    url = new URL(`${input}`, globalThis.location?.href);
  } catch {
    throw new DOMException(`The URL '${input}' is invalid.`, "SyntaxError");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new DOMException(
      `The URL's scheme must be 'ws', 'wss', 'http' or 'https'; '${url.protocol.slice(0, -1)}' is not allowed.`,
      "SyntaxError",
    );
  }
  if (url.hash !== "" || `${input}`.includes("#")) {
    throw new DOMException(
      `The URL contains a fragment identifier ('${url.hash}'). Fragment identifiers are not allowed in WebSocket URLs.`,
      "SyntaxError",
    );
  }
  return url.href;
}

function validateProtocols(protocols: string[]): void {
  const seen = new Set<string>();
  for (const protocol of protocols) {
    if (!TOKEN.test(protocol)) {
      throw new DOMException(`The subprotocol '${protocol}' is invalid.`, "SyntaxError");
    }
    if (seen.has(protocol)) {
      throw new DOMException(`The subprotocol '${protocol}' is duplicated.`, "SyntaxError");
    }
    seen.add(protocol);
  }
}
