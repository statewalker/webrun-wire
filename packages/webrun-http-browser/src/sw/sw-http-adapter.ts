import type { HttpHandler } from "@statewalker/webrun-http-streams";
import { callChannel, callChannelWithin, handleChannelCalls } from "../core/data-calls.js";
import { withDeadline } from "../core/deadline.js";
import {
  awaitServiceWorkerControl,
  DEFAULT_SERVICE_WORKER_TIMEOUT,
  ServiceWorkerControlError,
} from "../core/service-worker-control.js";
import { HTTP_LINK_PROTOCOL } from "../link/http-link.js";
import { heldLockNames, holdLock, locksAvailable, newLockName } from "../link/locks.js";
import {
  createWebSocketClass,
  type PortWebSocketClass,
  type WebSocketClassOptions,
  type WebSocketConnection,
} from "../ws/client.js";
import { serveWebSocketUpgrade } from "../ws/upgrade.js";
import { HandlerEndpoint } from "./handler-endpoint.js";
import {
  ATTACH_CALL,
  type AttachParams,
  type AttachReply,
  DETACH_CALL,
  DRAIN_CALL,
  KEEPALIVE_MESSAGE,
  NEED_LINKS_CALL,
  type NeedLinksParams,
  WAKE_MESSAGE,
  WORKER_HELLO,
  type WorkerControlMessage,
  WS_CONNECT_CALL,
} from "./protocol.js";
import { resolveWorkerUrl } from "./worker-url.js";

export interface SwHttpAdapterOptions {
  /** The first path segment under the scope that this page's handlers serve. */
  key: string;
  scope?: string;
  serviceWorkerUrl?: string;
  /**
   * Upper bound, in ms, for `start()`'s wait for the worker to activate, take
   * control of the page and answer the handshake. `start()` rejects with a
   * `ServiceWorkerControlError` past it instead of waiting forever.
   * Default `DEFAULT_SERVICE_WORKER_TIMEOUT` (30 s).
   */
  timeout?: number;
  /**
   * If the page is still uncontrolled once the worker is active — after a
   * hard reload, say — and the worker does not take it over when asked,
   * reload the page once instead of rejecting. Default `false`.
   */
  reloadIfUncontrolled?: boolean;
  /**
   * Per-stream inactivity timeout of the links, in ms (webrun-rpc's): a
   * request or response body with no chunk for that long fails. Unset — the
   * default — means none: a slow reader is throttled, never failed.
   */
  streamTimeout?: number;
  /** The handler slot of this page's own handlers. Default: one per adapter. */
  id?: string;
  /** What a `route` function in the ServiceWorker sees of this page's handlers. */
  meta?: unknown;
  /** Options of the `WebSocket` class (`adapter.WebSocket`). */
  webSocket?: WebSocketClassOptions;
  /** @deprecated Version 1 only; ignored. */
  bindPort?: (port: MessagePort) => void | Promise<void>;
}

export interface SwHttpRegistration {
  baseUrl: string;
  prefix: string;
  remove(): Promise<void>;
}

export interface AttachWorkerOptions {
  /** The key the worker serves. Default: the adapter's. */
  key?: string;
  /** The handler slot. Attaching an id the key has already replaces it. Default: a fresh one. */
  id?: string;
  /** What a `route` function sees of this handler. */
  meta?: unknown;
}

/** A Dedicated Worker attached as a handler. */
export interface WorkerLink {
  readonly key: string;
  readonly id: string;
  /** Token of this attachment; `drain` and `detach` name it. */
  readonly owner: string;
  /**
   * Hand-over: the worker gets no new requests (they wait for the next owner
   * of the slot), and those in flight may finish for up to `ms`. Then the
   * link is closed.
   */
  drain(options?: { ms?: number }): Promise<void>;
  /** Removes the link now. Requests in flight fail. */
  detach(): Promise<void>;
}

/**
 * The page side of the same-origin ServiceWorker: registers the worker, and
 * attaches handler links to it.
 *
 * - `register(prefix, handler)` serves a handler in this page, under
 *   `<scope>/<key>/...`.
 * - `attachWorker(worker)` links a Dedicated Worker that runs
 *   `serveHttpInWorker(handler)`: the ServiceWorker then talks to the worker
 *   directly, and this page carries nothing.
 * - `connectWebSocket(url, protocols)` and `WebSocket` open sockets to
 *   handlers, through the ServiceWorker or straight to a handler of this page.
 *
 * Links are attached again whenever the ServiceWorker asks (after a restart),
 * and requests in flight on a handler that dies fail at once.
 */
export class SwHttpAdapter {
  readonly options: SwHttpAdapterOptions;
  private readonly _handlers = new Map<string, HttpHandler>();
  private readonly _endpoint: HandlerEndpoint;
  private readonly _ownerLock = newLockName("webrun-http-owner");
  private readonly _id: string;
  private readonly _owner = crypto.randomUUID();
  private readonly _workers = new Set<WorkerLinkImpl>();
  private _releaseOwner?: () => void;
  private _serviceWorkerUrl?: string;
  private _serviceWorker?: ServiceWorker;
  private _registration?: ServiceWorkerRegistration;
  private _registrationPromise?: Promise<void>;
  private _cleanup: Array<() => void> = [];
  private _attaching?: Promise<void>;
  private _routerLock?: string;
  private _WebSocket?: PortWebSocketClass;

  constructor(options: SwHttpAdapterOptions) {
    this.options = options;
    if (!this.key) throw new Error("Key is not defined.");
    if (!this.scope) throw new Error("Scope is not defined");
    this._id = options.id ?? `page:${crypto.randomUUID()}`;
    this._endpoint = new HandlerEndpoint((request) => this._handleHttpRequest(request), {
      streamTimeout: options.streamTimeout,
    });
  }

  get key(): string {
    return this.options.key;
  }

  get scope(): string {
    return this.options.scope ?? new URL("./", this.serviceWorkerUrl).pathname;
  }

  /**
   * The scope as a url on the worker's origin. Resolved against the worker's
   * own url when one is given, not against this module's: a bundle that is
   * not an ES module (an IIFE, Theia's frontend) has no `import.meta.url`, and
   * `new URL(scope, undefined)` threw `Invalid URL` there. Only without a
   * worker url does the module's location decide (its default `sw-worker.js`
   * sits next to it).
   */
  get rootUrl(): URL {
    const base = this.options.serviceWorkerUrl ? this.serviceWorkerUrl : import.meta.url;
    return new URL(this.scope, base);
  }

  get serviceWorkerUrl(): string {
    if (!this._serviceWorkerUrl) {
      const url = this.options.serviceWorkerUrl
        ? resolveWorkerUrl(this.options.serviceWorkerUrl)
        : new URL("./sw-worker.js", this.rootUrl);
      this._serviceWorkerUrl = `${url}`;
    }
    return this._serviceWorkerUrl;
  }

  /**
   * Registers the worker and waits until it is activated and controls this
   * page, then attaches this page's handler link. The page must be controlled,
   * because only a controlled page's `fetch()` reaches the worker. When the
   * page loaded uncontrolled (a hard reload does that), the worker is asked to
   * claim it. Rejects with a `ServiceWorkerControlError` when that fails or
   * `timeout` passes (`reason` says which step); a later `start()` tries
   * again.
   */
  async start(): Promise<void> {
    if (!this._registrationPromise) {
      this._registrationPromise = (async () => {
        const registration = await navigator.serviceWorker.register(this.serviceWorkerUrl, {
          scope: this.scope,
        });
        this._registration = registration;
        const stopListening = handleChannelCalls(
          navigator.serviceWorker,
          NEED_LINKS_CALL,
          async (_event, params) => {
            await this.relink((params as NeedLinksParams | undefined)?.routerLock);
            return true;
          },
        );
        const onControllerChange = () => {
          const controller = navigator.serviceWorker.controller;
          if (controller) this._serviceWorker = controller;
        };
        navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
        this._cleanup.push(stopListening, () =>
          navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange),
        );

        const timeout = this.options.timeout ?? DEFAULT_SERVICE_WORKER_TIMEOUT;
        const deadline = Date.now() + timeout;
        try {
          this._serviceWorker = await awaitServiceWorkerControl(registration, {
            timeout,
            reloadIfUncontrolled: this.options.reloadIfUncontrolled,
          });
          this._releaseOwner ??= await holdLock(this._ownerLock);
          await withDeadline(
            deadline,
            this._attachPage(),
            () =>
              new ServiceWorkerControlError(
                "unresponsive",
                `ServiceWorker "${this._serviceWorker?.scriptURL}" controls this page but did ` +
                  `not answer the UPDATE_COMMUNICATION_PORT handshake within ${timeout} ms. ` +
                  "Check that the worker script runs this package's same-origin dispatcher " +
                  "(it importScripts `sw-worker.js`, or calls `startHttpDispatcher`).",
              ),
          );
        } catch (error) {
          // Forget this attempt so a later start() retries. Keep the
          // registration: the worker is fine — it is this page that is not
          // controlled, and other pages may be using the worker.
          for (const cleanup of this._cleanup.splice(0)) cleanup();
          this._registration = undefined;
          this._registrationPromise = undefined;
          throw error;
        }
      })();
    }
    return this._registrationPromise;
  }

  /** Detaches every link, and unregisters the worker. */
  async stop(): Promise<void> {
    for (const cleanup of this._cleanup.splice(0)) cleanup();
    for (const worker of [...this._workers]) await worker.detach().catch(() => {});
    const sw = this._serviceWorker;
    if (sw) {
      await callChannel(sw, DETACH_CALL, { key: this.key, id: this._id, owner: this._owner }).catch(
        () => {},
      );
    }
    await this._endpoint.unlink();
    this._releaseOwner?.();
    this._releaseOwner = undefined;
    const registration = this._registration;
    this._registration = undefined;
    this._registrationPromise = undefined;
    try {
      await registration?.unregister();
    } catch (error) {
      console.log("Service Worker unregistration failed: ", error);
    }
  }

  /**
   * Registers an HTTP handler on a prefix. Returns the resulting base URL and a
   * disposer.
   */
  async register(prefix: string, handler: HttpHandler): Promise<SwHttpRegistration> {
    const cleanPrefix = `./${(prefix ?? "").replace(/^[./]+/, "")}`;
    const baseUrl = `${new URL(cleanPrefix, this.rootUrl)}`;
    this._handlers.set(baseUrl, handler);
    const handlers = this._handlers;
    return {
      baseUrl,
      prefix: cleanPrefix,
      async remove() {
        handlers.delete(baseUrl);
      },
    };
  }

  /**
   * Links a Dedicated Worker that runs `serveHttpInWorker(handler)` as a
   * handler of `key`. The ServiceWorker sends it requests directly, without
   * this page relaying anything, so a busy or throttled page does not slow
   * them down.
   */
  async attachWorker(worker: Worker, options: AttachWorkerOptions = {}): Promise<WorkerLink> {
    await this.start();
    // The hello is repeated until the worker answers: a worker that calls
    // `serveHttpInWorker` only after an `await` has no listener yet, and a
    // message to a worker with no listener is lost.
    const controls: MessagePort[] = [];
    let retry: ReturnType<typeof setInterval> | undefined;
    const answered = new Promise<{ control: MessagePort; ownerLock?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(retry);
          for (const port of controls) port.close();
          reject(
            new Error(
              "The worker did not answer within the timeout. Does it call serveHttpInWorker()?",
            ),
          );
        }, this.options.timeout ?? DEFAULT_SERVICE_WORKER_TIMEOUT);
        const hello = () => {
          const channel = new MessageChannel();
          controls.push(channel.port1);
          channel.port1.onmessage = (event) => {
            const message = event.data as WorkerControlMessage;
            if (message?.type !== "ready") return;
            clearTimeout(timer);
            clearInterval(retry);
            for (const port of controls) if (port !== channel.port1) port.close();
            resolve({ control: channel.port1, ownerLock: message.ownerLock });
          };
          worker.postMessage({ type: WORKER_HELLO }, [channel.port2]);
        };
        hello();
        retry = setInterval(hello, 500);
      },
    );
    const { control, ownerLock } = await answered;
    const key = options.key ?? this.key;
    const id = options.id ?? `worker:${crypto.randomUUID()}`;
    // Attaching a slot replaces whoever held it: the ServiceWorker lets the old
    // one finish its requests, and this page must not attach it again later.
    for (const old of [...this._workers]) {
      if (old.key === key && old.id === id) old.retire();
    }
    const link = new WorkerLinkImpl(this, control, {
      key,
      id,
      owner: crypto.randomUUID(),
      meta: options.meta,
      ownerLock,
    });
    this._workers.add(link);
    await link.attach();
    return link;
  }

  /**
   * Opens the transport of a socket to the handler `url` routes to: a handler
   * of this page directly, any other through the ServiceWorker. Resolves once
   * the handler accepted. An arrow function, so it can be handed around:
   * `createWebSocketClass(adapter.connectWebSocket)`.
   */
  connectWebSocket = async (
    url: string | URL,
    protocols: string[] = [],
  ): Promise<WebSocketConnection> => {
    const httpUrl = new URL(`${url}`, globalThis.location?.href);
    if (httpUrl.protocol === "ws:") httpUrl.protocol = "http:";
    else if (httpUrl.protocol === "wss:") httpUrl.protocol = "https:";
    const local = this._findHandler(`${httpUrl}`);
    if (local) {
      // A handler in this very page needs no ServiceWorker.
      const result = await serveWebSocketUpgrade(local, { url: `${httpUrl}`, protocols });
      if (!result.ok) throw new Error(result.message);
      return { port: result.port, protocol: result.protocol };
    }
    await this.start();
    return await callChannelWithin<WebSocketConnection>(
      this._callTimeout(),
      this._worker(),
      WS_CONNECT_CALL,
      { url: `${httpUrl}`, protocols },
    );
  };

  /**
   * A WHATWG `WebSocket` class whose sockets reach this adapter's handlers:
   * `new adapter.WebSocket(`${baseUrl}chat`, ["v1"])`. The global
   * `WebSocket` is left alone.
   */
  get WebSocket(): PortWebSocketClass {
    this._WebSocket ??= createWebSocketClass(this.connectWebSocket, this.options.webSocket);
    return this._WebSocket;
  }

  /**
   * Attaches again every link not made for the router holding
   * `currentRouterLock` (every link, without it). The ServiceWorker asks for
   * this after a restart; a page may call it too.
   */
  async relink(currentRouterLock?: string): Promise<void> {
    if (!this._registrationPromise) return;
    const stale = (routerLock?: string) =>
      currentRouterLock === undefined || routerLock !== currentRouterLock;
    const jobs: Promise<void>[] = [];
    if (stale(this._routerLock)) jobs.push(this._attachPage());
    for (const worker of this._workers) {
      if (stale(worker.routerLock)) jobs.push(worker.attach());
    }
    await Promise.allSettled(jobs);
  }

  /** @internal Posts a plain message to the ServiceWorker, which starts it if stopped. */
  _poke(type: typeof WAKE_MESSAGE | typeof KEEPALIVE_MESSAGE): void {
    try {
      this._worker().postMessage({ type });
    } catch {}
  }

  /** @internal */
  _worker(): ServiceWorker {
    const worker =
      navigator.serviceWorker.controller ?? this._serviceWorker ?? this._registration?.active;
    if (!worker) throw new Error("The ServiceWorker is not running; call start() first");
    return worker;
  }

  /** @internal */
  _forget(link: WorkerLinkImpl): void {
    this._workers.delete(link);
  }

  /** @internal How long a call to the ServiceWorker may take. */
  _callTimeout(): number {
    return this.options.timeout ?? DEFAULT_SERVICE_WORKER_TIMEOUT;
  }

  private _attachPage(): Promise<void> {
    this._attaching ??= (async () => {
      try {
        const down = new MessageChannel();
        const ctl = new MessageChannel();
        const params: AttachParams = {
          wire: HTTP_LINK_PROTOCOL,
          key: this.key,
          id: this._id,
          owner: this._owner,
          // Sent only when held for real: without Web Locks the ServiceWorker
          // falls back to `clients.get()`, which an owner lock would skip.
          ownerLock: this._releaseOwner && locksAvailable() ? this._ownerLock : undefined,
          meta: this.options.meta,
          ctl: true,
        };
        const reply = await callChannelWithin<AttachReply>(
          this._callTimeout(),
          this._worker(),
          ATTACH_CALL,
          params,
          down.port1,
          ctl.port1,
        );
        checkReply(reply, this._worker());
        // The previous link is not dropped here: the endpoint lets it finish
        // what it serves (see `HandlerEndpoint.link`).
        await this._endpoint.link(this.key, { down: down.port2, ctl: ctl.port2 }, reply.routerLock);
        this._routerLock = reply.routerLock;
      } finally {
        this._attaching = undefined;
      }
    })();
    return this._attaching;
  }

  private _findHandler(url: string): HttpHandler | undefined {
    for (const [urlPrefix, handler] of this._handlers) {
      if (url.indexOf(urlPrefix) === 0) return handler;
    }
    return undefined;
  }

  private async _handleHttpRequest(request: Request): Promise<Response> {
    const handler = this._findHandler(request.url);
    if (handler) return await handler(request);
    return new Response(null, { status: 404, statusText: "Error 404: Not found" });
  }
}

class WorkerLinkImpl implements WorkerLink {
  readonly key: string;
  readonly id: string;
  readonly owner: string;
  routerLock?: string;
  private readonly _meta: unknown;
  private readonly _ownerLock?: string;
  private _attaching?: Promise<void>;
  private _detached = false;

  constructor(
    private readonly _adapter: SwHttpAdapter,
    private readonly _control: MessagePort,
    init: { key: string; id: string; owner: string; meta?: unknown; ownerLock?: string },
  ) {
    this.key = init.key;
    this.id = init.id;
    this.owner = init.owner;
    this._meta = init.meta;
    this._ownerLock = init.ownerLock;
    _control.onmessage = (event) => {
      const message = event.data as WorkerControlMessage;
      if (message?.type === "relink") {
        // Starts the ServiceWorker if it was stopped; the attach follows.
        this._adapter._poke(WAKE_MESSAGE);
        void this.attach().catch(() => {});
      } else if (message?.type === "keepalive") this._adapter._poke(KEEPALIVE_MESSAGE);
    };
  }

  /**
   * Forgets this link without telling the ServiceWorker: another attachment
   * took its slot, and the ServiceWorker retires it by itself.
   */
  retire(): void {
    this._detached = true;
    this._adapter._forget(this);
    this._control.onmessage = null;
  }

  /** Makes fresh channels and attaches them; the worker gets its ends. */
  attach(): Promise<void> {
    if (this._detached) return Promise.resolve();
    this._attaching ??= (async () => {
      try {
        // A worker that was terminated holds no owner lock any more: attaching
        // it again would route requests to it until the ServiceWorker noticed.
        if (this._ownerLock) {
          const held = await heldLockNames();
          if (held && !held.has(this._ownerLock)) {
            this.retire();
            return;
          }
        }
        const down = new MessageChannel();
        const ctl = new MessageChannel();
        const up = new MessageChannel();
        const params: AttachParams = {
          wire: HTTP_LINK_PROTOCOL,
          key: this.key,
          id: this.id,
          owner: this.owner,
          ownerLock: this._ownerLock,
          meta: this._meta,
          ctl: true,
          up: true,
        };
        const sw = this._adapter._worker();
        const reply = await callChannelWithin<AttachReply>(
          this._adapter._callTimeout(),
          sw,
          ATTACH_CALL,
          params,
          down.port1,
          ctl.port1,
          up.port1,
        );
        checkReply(reply, sw);
        this.routerLock = reply.routerLock;
        this._control.postMessage(
          {
            type: "link",
            key: this.key,
            routerLock: reply.routerLock,
          } satisfies WorkerControlMessage,
          [down.port2, ctl.port2, up.port2],
        );
      } finally {
        this._attaching = undefined;
      }
    })();
    return this._attaching;
  }

  async drain({ ms }: { ms?: number } = {}): Promise<void> {
    if (this._detached) return;
    this._detached = true;
    this._adapter._forget(this);
    try {
      await callChannel(this._adapter._worker(), DRAIN_CALL, {
        key: this.key,
        id: this.id,
        owner: this.owner,
        ms,
      });
    } finally {
      this._unlink();
    }
  }

  async detach(): Promise<void> {
    if (this._detached) return;
    this._detached = true;
    this._adapter._forget(this);
    await callChannel(this._adapter._worker(), DETACH_CALL, {
      key: this.key,
      id: this.id,
      owner: this.owner,
    }).catch(() => {});
    this._unlink();
  }

  private _unlink(): void {
    this._control.postMessage({ type: "unlink", key: this.key } satisfies WorkerControlMessage);
    this._control.onmessage = null;
  }
}

function checkReply(
  reply: AttachReply | undefined,
  sw: ServiceWorker,
): asserts reply is AttachReply {
  if (reply?.accepted === HTTP_LINK_PROTOCOL) return;
  throw new ServiceWorkerControlError(
    "incompatible",
    `ServiceWorker "${sw.scriptURL}" answered the handshake but does not speak ` +
      `${HTTP_LINK_PROTOCOL}: it runs an older version of @statewalker/webrun-http-browser. ` +
      "Reload the page once the updated worker is active.",
  );
}
