/**
 * The messages between pages, Dedicated Workers and the same-origin
 * ServiceWorker. Internal: the shapes may change between versions, which is
 * why every hand-shake carries `HTTP_LINK_PROTOCOL`.
 *
 * THREE PORTS PER HANDLER LINK. A page makes the channels and hands one end of
 * each to the handler (itself, or a worker) and the other to the
 * ServiceWorker; after that it carries nothing:
 *
 * - `down`: ServiceWorker → handler, the requests the handler serves;
 * - `ctl`: a raw port next to them, for what HTTP over a stream cannot carry,
 *   transferred `MessagePort`s (WebSocket hand-over);
 * - `up` (workers only): handler → ServiceWorker, the requests the handler
 *   sends through the router (to other handlers).
 */

/** Page → ServiceWorker: attach a handler link. The name is the one version 1 used. */
export const ATTACH_CALL = "UPDATE_COMMUNICATION_PORT";
/** Page → ServiceWorker: remove a handler link now. */
export const DETACH_CALL = "webrun-http:detach";
/** Page → ServiceWorker: stop routing to a link, let its requests finish, then remove it. */
export const DRAIN_CALL = "webrun-http:drain";
/** Page → ServiceWorker: open a WebSocket to a handler. */
export const WS_CONNECT_CALL = "webrun-http:ws-connect";
/** ServiceWorker → pages: attach your links again (the ServiceWorker restarted). */
export const NEED_LINKS_CALL = "webrun-http:need-links";
/**
 * Page → ServiceWorker, plain messages (no reply). A message to the
 * ServiceWorker object is an event: it starts a stopped worker and resets its
 * idle timer. Port messages do neither.
 */
export const WAKE_MESSAGE = "webrun-http:wake";
export const KEEPALIVE_MESSAGE = "webrun-http:keepalive";

export interface AttachParams {
  /** `HTTP_LINK_PROTOCOL`; absent from version 1 pages. */
  wire?: string;
  key: string;
  /** The handler slot. Attaching an id that is attached already replaces it. */
  id?: string;
  /** Token of this attachment, named by `drain` / `detach`. */
  owner?: string;
  /** A Web Lock the handler holds while it lives. */
  ownerLock?: string;
  /** Whatever the host wants a `route` function to see. */
  meta?: unknown;
  /** Which ports follow `down` in the transfer list, in this order. */
  ctl?: boolean;
  up?: boolean;
}

export interface AttachReply {
  /** `HTTP_LINK_PROTOCOL`: proves the worker speaks it. */
  accepted: string;
  /** The Web Lock the ServiceWorker holds while it lives; absent without Web Locks. */
  routerLock?: string;
}

export interface DrainParams {
  key: string;
  id: string;
  owner: string;
  /** How long requests in flight may run before the link is closed anyway. */
  ms?: number;
}

export interface NeedLinksParams {
  /** Links made for this router are alive; only the others need attaching again. */
  routerLock?: string;
}

/** The `ctl` port's messages. */
export type ControlMessage =
  // ServiceWorker → handler: a caller asks for a socket.
  | {
      t: "ws-connect";
      id: string;
      url: string;
      protocols: string[];
      headers?: [string, string][];
    }
  // handler → ServiceWorker: the answer (`port` is transferred).
  | { t: "ws-accept"; id: string; protocol: string; port: MessagePort }
  | { t: "ws-refuse"; id: string; status: number; message: string }
  // handler → ServiceWorker: the handler itself asks for a socket to another handler.
  | { t: "ws-open"; id: string; url: string; protocols: string[] }
  | { t: "ws-opened"; id: string; protocol: string; port: MessagePort }
  | { t: "ws-failed"; id: string; message: string };

/** Page ↔ worker: what `attachWorker` and `serveHttpInWorker` exchange. */
export const WORKER_HELLO = "webrun-http:worker-hello";

export type WorkerControlMessage =
  // worker → page, once: the worker serves, and holds this owner lock.
  | { type: "ready"; ownerLock?: string }
  // page → worker: a fresh link (ports: down, ctl, up).
  | { type: "link"; key: string; routerLock?: string }
  // page → worker: drop the links of this key.
  | { type: "unlink"; key: string }
  // worker → page: my links are dead and a call waits; attach me again.
  | { type: "relink" }
  // worker → page: a call is in flight; keep the ServiceWorker awake.
  | { type: "keepalive" };
