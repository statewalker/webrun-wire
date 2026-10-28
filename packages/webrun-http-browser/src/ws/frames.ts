/**
 * The wire protocol of a WebSocket carried over a `MessagePort`.
 *
 * A `MessagePort` is a natural carrier for a WebSocket: messages arrive in
 * order, and strings and transferable `ArrayBuffer`s cross it as they are. The
 * protocol on top is these frames, the same in both directions:
 *
 * - `m` — one message. An `ArrayBuffer` is transferred, never copied.
 * - `c` — close. The side that closes first sends it; the other answers with
 *   its own `c` (the echo), and both are then closed cleanly.
 * - `p` — ping, client to server, carrying the client's heartbeat period.
 * - `q` — pong, server to client.
 * - `a` — ack: the receiver consumed `n` more bytes of messages. This is the
 *   flow control: what a side has sent and not yet seen acknowledged is its
 *   `bufferedAmount`, and the server end can wait for it to fall
 *   (`whenDrained`). Added in version 2; version 1 had no backpressure.
 *
 * HEARTBEAT. A `MessagePort` never reports that the other side died, so the
 * client pings every `hb` ms and closes with 1006 when pongs stop for `2·hb`;
 * the server closes with 1006 when pings stop for `3·hb`. That is how a socket
 * notices a closed tab or a terminated worker.
 *
 * Unknown frames are ignored, so a later version can add frames a peer of
 * this version skips.
 */

/** The version of this frame protocol. Sent in the upgrade hand-shake. */
export const WS_PORT_PROTOCOL_VERSION = 2;

/** Default heartbeat period of the client, in ms. */
export const DEFAULT_HEARTBEAT_MS = 10_000;

/** How long a side waits for the echo of its close frame, in ms. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export type WsFrame =
  | { t: "m"; d: string | ArrayBuffer }
  | { t: "c"; code: number; reason: string }
  | { t: "p"; hb: number }
  | { t: "q" }
  | { t: "a"; n: number };

/**
 * The timer functions a socket uses. On a page's main thread, background
 * throttling delays timers by up to a minute, which would close healthy
 * sockets; pass unthrottled ones (worker-timers, say) there.
 */
export interface WsTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export const defaultTimers: WsTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

/** Recovers a frame from a message's data, or `undefined` for anything else. */
export function readFrame(data: unknown): WsFrame | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const frame = data as { t?: unknown; d?: unknown; code?: unknown; reason?: unknown };
  switch (frame.t) {
    case "m":
      return typeof frame.d === "string" || frame.d instanceof ArrayBuffer
        ? (frame as WsFrame)
        : undefined;
    case "c":
      return {
        t: "c",
        code: typeof frame.code === "number" ? frame.code : 1005,
        reason: typeof frame.reason === "string" ? frame.reason : "",
      };
    case "p": {
      const hb = (frame as { hb?: unknown }).hb;
      return { t: "p", hb: typeof hb === "number" && hb > 0 ? hb : DEFAULT_HEARTBEAT_MS };
    }
    case "q":
      return { t: "q" };
    case "a": {
      const n = (frame as { n?: unknown }).n;
      return typeof n === "number" && n >= 0 ? { t: "a", n } : undefined;
    }
    default:
      return undefined;
  }
}

/** Posts `frame`, transferring a message's `ArrayBuffer`. */
export function postFrame(port: MessagePort, frame: WsFrame): void {
  if (frame.t === "m" && frame.d instanceof ArrayBuffer) port.postMessage(frame, [frame.d]);
  else port.postMessage(frame);
}

/** The size a message counts for in `bufferedAmount`: UTF-8 bytes, or the buffer's length. */
export function messageSize(data: string | ArrayBuffer): number {
  return typeof data === "string" ? utf8Length(data) : data.byteLength;
}

/** The UTF-8 length of `text`, without encoding it. */
export function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}
