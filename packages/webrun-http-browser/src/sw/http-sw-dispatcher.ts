/// <reference lib="webworker" />

import { get, set } from "idb-keyval";
import { callChannel, handleChannelCalls, withTransfer } from "../core/data-calls.js";
import { handleClaimRequests } from "../core/service-worker-control.js";
import type { FetchEventLike, ServiceWorkerScope } from "../core/sw-scope.js";
import { sendHttpRequest } from "../http/http-send-recieve.js";
import { errorMessage } from "../link/errors.js";
import {
  connectHttpLink,
  HTTP_LINK_PROTOCOL,
  type HttpLink,
  LinkLostError,
  serveHttpLink,
  trackedLink,
} from "../link/http-link.js";
import { heldLockNames, holdLock, locksAvailable, newLockName, watchLock } from "../link/locks.js";
import { PortRendezvous } from "../link/rendezvous.js";
import type { WebSocketConnection } from "../ws/client.js";
import { newWebSocketUpgradeRequest } from "../ws/upgrade.js";
import {
  type HandlerInfo,
  HandlerTable,
  leastInflightRoute,
  type RouteFunction,
} from "./handler-table.js";
import {
  ATTACH_CALL,
  type AttachParams,
  type AttachReply,
  type ControlMessage,
  DETACH_CALL,
  DRAIN_CALL,
  type DrainParams,
  KEEPALIVE_MESSAGE,
  NEED_LINKS_CALL,
  type NeedLinksParams,
  WAKE_MESSAGE,
  WS_CONNECT_CALL,
} from "./protocol.js";

/**
 * The key a request's url belongs to, or `undefined` when it is none of this dispatcher's (the
 * request then goes to the network). `scope` is the worker's scope, with its trailing slash.
 */
export type KeyFunction = (url: URL, scope: string) => string | undefined;

/**
 * The default key: the url's first path segment under `scope`, decoded; none outside it, at the
 * scope itself, or for a segment that does not decode.
 */
export function scopeKey(url: URL, scope: string): string | undefined {
  const href = `${url}`;
  if (!href.startsWith(scope)) return undefined;
  const key = href
    .substring(scope.length)
    .replace(/[?#].*$/, "")
    .split("/")[0];
  if (!key) return undefined;
  try {
    return decodeURIComponent(key);
  } catch {
    return undefined; // a malformed escape (`%E0`): no key, so the request goes to the network
  }
}

/** What went wrong with a request the dispatcher took, for the `failure` option. */
export interface DispatchFailure {
  /**
   * - `"timeout"`: no handler `route` accepts attached within `attachTimeoutMs` (a hand-over,
   *   or `route` waiting for one handler in particular);
   * - `"gone"`: the key was served before, and no handler is left (its tab closed);
   * - `"lost"`: sending to the handler failed: lost while the request was in flight
   *   (`error` is then a `LinkLostError`), or the stream failed otherwise (a `streamTimeout`, a
   *   request body that errored). A handler lost once the response head is out fails the body
   *   instead, and never reaches `failure`.
   */
  kind: "timeout" | "gone" | "lost";
  error?: unknown;
}

export interface SwHttpDispatcherOptions {
  self: ServiceWorkerScope;
  log?: (...args: unknown[]) => void;
  /**
   * Which key a url belongs to. Default `scopeKey`: the first path segment under the scope, and
   * none outside it. A host with another layout gives its own: a project at the origin's root,
   * projects under a base path. It decides for `dispatch()` (and so a handler's `service.fetch`),
   * for sockets, and for `fetch` events of this origin's urls.
   *
   * A key it gives a url of another origin serves handlers' `service.fetch` (through
   * `dispatch()`) and sockets, which this worker brokers whoever opens them (pages of this origin
   * included). A page's own `fetch` to that origin stays the browser's: `fetch` events for other
   * origins are left alone, so it goes to the network as it would without the worker.
   *
   * It runs synchronously, in the `fetch` listener; it must not throw. A handler registered in a
   * page (`SwHttpAdapter.register`) serves only urls under its own `baseUrl` (prefix `""` makes
   * that the scope): a url the function maps to its key from elsewhere reaches the page and gets
   * a 404 there, where a handler in a worker (`serveHttpInWorker`) takes any url.
   */
  key?: KeyFunction;
  /**
   * Whether the dispatcher listens to `fetch` events itself. Default `true`. With `false` the
   * host's own `fetch` listener runs instead: it answers its own routes and hands the rest to
   * `dispatcher.handleFetch(event)`. For a dispatcher the host constructs (`new
   * SwHttpDispatcher`): `startHttpDispatcher` refuses it, as nothing could call `handleFetch`
   * then. The `install`/`activate` handlers (`skipWaiting`, `clients.claim`) stay on either way.
   */
  handleFetch?: boolean;
  /**
   * The answer to a request the dispatcher took and could not deliver (`DispatchFailure`).
   * Default: 503 for `"timeout"`, 404 for `"gone"`, a plain-text 502 with the error for
   * `"lost"`. A host whose callers expect another shape (an error its RPC layer rethrows, say)
   * answers in it here. If it throws, the default answers.
   */
  failure?: (request: Request, failure: DispatchFailure) => Response | Promise<Response>;
  /**
   * The headers a socket's upgrade carries to `route` and to its handler, by who asked for it:
   * `"page"` (a page's `connectWebSocket`, `serviceWorkerWebSocketClass`) or `"handler"` (a
   * handler's `service.connectWebSocket`). Default: as given. A host whose handlers trust some
   * headers (routing between its own workers) drops them from pages' sockets here, as it would
   * from pages' fetches. `from` says which path a socket came by, not whom to trust: any page of
   * this origin can attach a handler and ask as one.
   */
  socketHeaders?: (
    headers: [string, string][] | undefined,
    from: "page" | "handler",
  ) => [string, string][] | undefined;
  /**
   * The answer to a navigation under the scope whose key nobody serves (also one taken before
   * the stored keys are read, after a restart). Default `fetch(request)`, the network. A host
   * with a page of its own for such urls answers with it here. Other requests nobody serves
   * always go to the network.
   */
  unserved?: (request: Request) => Response | Promise<Response>;
  /**
   * Picks the handler of a request among the live handlers of its key.
   * Default `leastInflightRoute`: the fewest requests in flight, the oldest on
   * a tie — with one tab per key, the first live handler, as before.
   */
  route?: RouteFunction;
  /**
   * How long a request waits for a handler while its key is handed over (the
   * handlers it has are all draining, or `route` picked none), in ms. Past
   * it, 503. Default 15 s.
   */
  attachTimeoutMs?: number;
  /**
   * How long a request for a key with no handler waits for the pages to
   * attach their links again (after a ServiceWorker restart), in ms. Past it,
   * 404 for a key this worker has served before. Default 3 s.
   */
  relinkTimeoutMs?: number;
  /** How long a replaced link may finish its requests, in ms. Default 5 s. */
  handoverMs?: number;
  /** How long a socket waits for its handler's answer, in ms. Default 15 s. */
  wsConnectTimeoutMs?: number;
  /** Per-stream inactivity timeout of the links (webrun-rpc's). Default none. */
  streamTimeout?: number;
  /**
   * The window, in bytes, of the links to the handlers: `HttpLinkOptions.window`.
   * Default 256 KiB; 0 turns it off.
   */
  window?: number;
  /**
   * Period of the backup liveness check, in ms: handlers whose owner lock is
   * no longer held are dropped. Default 5 s; 0 turns it off.
   */
  livenessCheckMs?: number;
}

/** One attached handler link, as the ServiceWorker holds it. */
class HandlerEntry implements HandlerInfo {
  draining = false;
  readonly attachedAt = Date.now();
  readonly sockets: PortRendezvous<WebSocketConnection>;
  stopWatch: () => void = () => {};
  closeUp?: () => Promise<void>;

  constructor(
    readonly key: string,
    readonly id: string,
    readonly owner: string,
    readonly meta: unknown,
    readonly link: HttpLink,
    readonly ctl: MessagePort | undefined,
    readonly clientId: string | undefined,
    readonly ownerLock: string | undefined,
  ) {
    this.sockets = new PortRendezvous(`s:${id}`);
  }

  get inflight(): number {
    return this.link.inflight;
  }
}

/** The reason requests fail with when their handler dies under them. */
export const HANDLER_LOST_MESSAGE = "The handler was lost while this request was in flight";

const TIMED_OUT = Symbol("timed-out");

/**
 * The same-origin ServiceWorker: routes `fetch` events under its scope to
 * handler links that pages attach — handlers in the pages themselves
 * (`SwHttpAdapter.register`) or in Dedicated Workers
 * (`SwHttpAdapter.attachWorker` + `serveHttpInWorker`).
 *
 * A url `<scope>/<key>/...` belongs to the handlers of `key` (the `key`
 * option maps urls to keys some other way). Of those, the
 * `route` option picks one per request. Requests and responses stream with
 * backpressure in both directions, and an aborted fetch reaches the handler
 * as a cancellation (webrun-rpc + webrun-http-streams).
 *
 * Urls of keys this worker never served go to the network untouched: the
 * worker does not call `respondWith` for them.
 *
 * RESTARTS. The browser stops an idle ServiceWorker, and every port it held
 * dies with it. Nothing is persisted but the set of keys ever served: the
 * first request after a restart asks every window to attach its links again
 * (`NEED_LINKS`) and waits for them.
 *
 * LIVENESS. Each handler holds an owner lock; when it is granted to this
 * worker, the handler is gone and its requests in flight fail at once (502).
 * This worker holds a router lock that handlers watch the same way.
 */
export class SwHttpDispatcher {
  readonly self: ServiceWorkerScope;
  /** `self`, with the WebWorker lib's types this module compiles with. */
  private readonly _sw: ServiceWorkerGlobalScope;
  readonly log: (...args: unknown[]) => void;
  readonly options: SwHttpDispatcherOptions;
  readonly table = new HandlerTable<HandlerEntry>();
  /**
   * Keys that were served at some point on this worker (sticky, kept in
   * IndexedDB). Lets a fetch tell "a site url whose handler is gone → 404"
   * from "an unknown url under the scope → the network".
   */
  readonly claimedKeys = new Set<string>();
  /** The Web Lock this worker holds while it lives; handlers watch it. */
  readonly routerLock?: string;
  private _routerHeld: Promise<void> = Promise.resolve();
  private _restored: Promise<void> = Promise.resolve();
  private _restoreSettled = false;
  private _cleanup: Array<() => void> = [];
  private _livenessTimer?: ReturnType<typeof setInterval>;
  private readonly _relinkRounds = new Map<string, { at: number; done: Promise<void> }>();
  /** Keys whose last handler was drained: until the time stored, requests wait for the next. */
  private readonly _vacant = new Map<string, number>();

  constructor(options: SwHttpDispatcherOptions) {
    this.options = options;
    this.self = options.self;
    this._sw = options.self as unknown as ServiceWorkerGlobalScope;
    this.log = options.log ?? (() => {});
    if (locksAvailable()) this.routerLock = newLockName("webrun-http-router");
  }

  get scope(): string {
    // The registration's scope, which the page may have set to another folder than the script's
    // (`register(url, { scope })`); the script's folder where there is no registration to ask.
    return this._sw.registration?.scope ?? `${new URL("./", this._sw.location.href)}`;
  }

  /** The key `url` belongs to (the `key` option; by default its first path segment under the scope). */
  keyOf(url: string | URL): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(`${url}`);
    } catch {
      return undefined; // not an absolute url: nobody's
    }
    return (this.options.key ?? scopeKey)(parsed, this.scope);
  }

  /** Whether `key` has ever been served on this worker. */
  isClaimedKey(key: string): boolean {
    return this.claimedKeys.has(key);
  }

  /** Whether requests for `key` are this worker's to answer. */
  serves(key: string): boolean {
    return this.claimedKeys.has(key) || this.table.all(key).length > 0;
  }

  start(): void {
    const self = this._sw;
    if (this.routerLock) this._routerHeld = holdLock(this.routerLock).then(() => {});
    this._restored = this._restoreClaimedKeys();
    const latch = () => {
      this._restoreSettled = true;
    };
    this._restored.then(latch, latch);

    this._cleanup.push(
      handleClaimRequests(self),
      handleChannelCalls(self, ATTACH_CALL, (event, params, ...ports) =>
        this._attach(event, params as AttachParams, ports),
      ),
      handleChannelCalls(self, DETACH_CALL, (_event, params) => {
        const entry = this._find(params as DrainParams);
        if (!entry) return false;
        this._close(entry, new LinkLostError("The handler was detached"));
        return true;
      }),
      handleChannelCalls(self, DRAIN_CALL, async (_event, params) => {
        const entry = this._find(params as DrainParams);
        if (!entry) return false;
        // Requests for the key wait for its next owner, even once this one
        // is gone, for up to `attachTimeoutMs`.
        this._vacant.set(entry.key, Date.now() + (this.options.attachTimeoutMs ?? 15_000));
        await this._retire(entry, (params as DrainParams).ms ?? this.options.handoverMs ?? 5_000);
        return true;
      }),
      handleChannelCalls(self, WS_CONNECT_CALL, async (event, params) => {
        if (!this._isOwnClient(event)) throw new Error("Only this origin's pages may open sockets");
        const { url, protocols, headers } = params as {
          url: string;
          protocols?: string[];
          headers?: [string, string][];
        };
        const connection = await this.connectWebSocket(
          url,
          protocols ?? [],
          this._socketHeaders(headers, "page"),
        );
        return withTransfer(connection, [connection.port]);
      }),
    );

    const onMessage = (event: ExtendableMessageEvent) => {
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === WAKE_MESSAGE) {
        // Started by this very message if it was stopped: hold it up until the
        // pages had a chance to link again.
        event.waitUntil(this._askForLinks());
      } else if (type === KEEPALIVE_MESSAGE) {
        // Receiving the message is what resets the idle timer.
        event.waitUntil(Promise.resolve());
      }
    };
    self.addEventListener("message", onMessage);
    this._cleanup.push(() => self.removeEventListener("message", onMessage));

    const onInstall = (event: ExtendableEvent) => {
      this.log("Skip waiting on install.");
      event.waitUntil(self.skipWaiting());
    };
    const onActivate = (event: ExtendableEvent) => {
      this.log("Claim control over all clients.");
      event.waitUntil(self.clients.claim());
    };
    const onFetch = (event: FetchEvent) => void this.handleFetch(event);
    self.addEventListener("install", onInstall);
    self.addEventListener("activate", onActivate);
    if (this.options.handleFetch !== false) self.addEventListener("fetch", onFetch);
    this._cleanup.push(() => {
      self.removeEventListener("install", onInstall);
      self.removeEventListener("activate", onActivate);
      self.removeEventListener("fetch", onFetch);
    });
  }

  async stop(): Promise<void> {
    for (const cleanup of this._cleanup.splice(0)) cleanup();
    if (this._livenessTimer) clearInterval(this._livenessTimer);
    this._livenessTimer = undefined;
    for (const entry of this.table.entries()) {
      this._close(entry, new LinkLostError("The ServiceWorker dispatcher stopped"));
    }
  }

  /**
   * Answers `request` as a fetch under the scope would be: through the
   * handler its key routes to. A url with no key (by default, one outside the
   * scope), or of a key this worker never served, goes to the network.
   */
  async dispatch(request: Request): Promise<Response> {
    const key = this.keyOf(request.url);
    if (key === undefined) return await fetch(request);
    await this._restored.catch(() => {});
    const entry = await this._acquire(request, key);
    if (entry === TIMED_OUT) return await this._failed(request, { kind: "timeout" });
    if (!entry) {
      if (!this.serves(key)) return await fetch(request);
      // Key was served at some point but has no live handler now (its tab
      // closed). 404 rather than the network: a dev server's SPA fallback
      // would serve the app shell for every site url and stale tabs would
      // keep resurrecting registrations.
      return await this._failed(request, { kind: "gone" });
    }
    try {
      return await entry.link.send(request);
    } catch (error) {
      this.log("[dispatch] failed", key, error);
      return await this._failed(request, { kind: "lost", error });
    }
  }

  /**
   * After `start()`: settles once the keys this worker served before a restart are read back
   * (whatever the outcome). Until then `serves()` may answer `false` for a key it will serve.
   */
  get ready(): Promise<void> {
    return this._restored.then(
      () => {},
      () => {},
    );
  }

  private _socketHeaders(
    headers: [string, string][] | undefined,
    from: "page" | "handler",
  ): [string, string][] | undefined {
    return this.options.socketHeaders ? this.options.socketHeaders(headers, from) : headers;
  }

  private async _failed(request: Request, failure: DispatchFailure): Promise<Response> {
    if (this.options.failure) {
      try {
        return await this.options.failure(request, failure);
      } catch (error) {
        this.log("[dispatch] the failure option threw; answering by default", error);
      }
    }
    if (failure.kind === "timeout") {
      return new Response(null, {
        status: 503,
        statusText: "Service Unavailable (no handler attached in time)",
      });
    }
    if (failure.kind === "gone") {
      return new Response(null, { status: 404, statusText: "Not Found (no active handler)" });
    }
    return new Response(errorMessage(failure.error), {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  /**
   * Opens a socket to the handler `url` routes to: the handler accepts or
   * refuses it like an HTTP upgrade, and the socket's port comes back. After
   * that the socket runs between the caller and the handler directly; this
   * worker is not on its data path.
   */
  async connectWebSocket(
    url: string,
    protocols: string[] = [],
    headers?: [string, string][],
  ): Promise<WebSocketConnection> {
    const request = newWebSocketUpgradeRequest(url, { protocols, headers });
    const key = this.keyOf(request.url);
    if (key === undefined) throw new Error(`${url} belongs to no key of this ServiceWorker`);
    await this._restored.catch(() => {});
    const entry = await this._acquire(request, key);
    if (!entry || entry === TIMED_OUT) throw new Error(`No handler serves ${url}`);
    if (!entry.ctl) throw new Error(`The handler of ${url} does not accept sockets`);
    const id = entry.sockets.newId();
    const answer = entry.sockets.wait(
      id,
      this.options.wsConnectTimeoutMs ?? 15_000,
      `the socket request for ${url}`,
    );
    entry.ctl.postMessage({
      t: "ws-connect",
      id,
      url: request.url,
      protocols,
      headers,
    } satisfies ControlMessage);
    return await answer;
  }

  /**
   * Answers `event` if it is the dispatcher's, with `request` (default `event.request`; a host
   * may pass a rewritten one, with headers it adds). Returns whether it called `respondWith`;
   * when it did not, the event is the caller's to answer or to leave to the network. For a host
   * that listens to `fetch` itself (`handleFetch: false`); call it synchronously in the event's
   * listener, as `respondWith` must be.
   *
   * It takes a same-origin request whose key (the `key` option) a handler serves, and also:
   * - a navigation under the scope whose key nobody serves (answered by `unserved`);
   * - before the stored keys are read (the first requests after a restart), every request with
   *   a key, since only then is it known whose it is: one nobody serves gets what it would have
   *   got after, `unserved` for a navigation and the network for anything else.
   * So a host with a page of its own for urls nobody serves gives it as `unserved`, rather than
   * deciding before calling this.
   */
  handleFetch(event: FetchEventLike, request: Request = event.request): boolean {
    // A navigation is told by the event's own request: a rewritten copy is no longer one (`new
    // Request(navigation, init)` makes its mode "same-origin").
    const navigation = event.request.mode === "navigate";
    // Another origin's url (a page's request to a CDN, an API) stays the
    // browser's even when the key function maps it: such keys serve handlers'
    // calls and sockets. No key: not ours either. No `respondWith` for those,
    // so the browser does the request exactly as it would without a worker.
    if (new URL(request.url).origin !== this._sw.location.origin) return false;
    const key = this.keyOf(request.url);
    if (key === undefined) return false;
    if (this._restoreSettled) {
      if (this.serves(key)) {
        event.respondWith(this.dispatch(request));
        return true;
      }
      if (navigation) {
        // A navigation under the scope is answered even when it is nobody's,
        // by passing it through: Firefox can leave a page uncontrolled when
        // its worker did not answer the navigation, and an uncontrolled page's
        // `fetch()` never reaches this worker. Everything else is left alone.
        event.respondWith(this._unserved(request));
        return true;
      }
      return false;
    }
    // Before the stored keys are read there is nothing to decide on, and
    // `respondWith` cannot be called after an await: claim the request, and
    // re-issue it if it turns out to be nobody's.
    event.respondWith(
      (async () => {
        await this._restored.catch(() => {});
        if (this.serves(key)) return await this.dispatch(request);
        // Nobody's: what it would have got once the keys were read, a navigation the
        // `unserved` answer, anything else the network.
        return navigation ? await this._unserved(request) : await fetch(request);
      })(),
    );
    return true;
  }

  /** What a request the dispatcher took, and no handler serves, gets: `unserved`, or the network. */
  private async _unserved(request: Request): Promise<Response> {
    return await (this.options.unserved ?? fetch)(request);
  }

  private async _attach(
    event: MessageEvent,
    params: AttachParams,
    ports: MessagePort[],
  ): Promise<AttachReply | AttachParams> {
    const clientId = (event.source as Client | null)?.id;
    const [down, ...rest] = ports;
    if (!down) throw new Error("An attach carries at least one port");
    this.log("[attach]", clientId, params);

    if (params.wire === undefined) {
      // A page of version 1 (before #32): its own stream transport, no
      // backpressure. Served as it was, until the page reloads; after a
      // restart it is asked for a port the way version 1 asked
      // (`_askLegacyPage`).
      const link = trackedLink(
        (request) => sendHttpRequest(down, request),
        () => down.close(),
      );
      const id = clientId ?? crypto.randomUUID();
      this._add(
        new HandlerEntry(params.key, id, id, undefined, link, undefined, clientId, undefined),
      );
      return { ...params };
    }
    if (params.wire !== HTTP_LINK_PROTOCOL) {
      for (const port of ports) port.close();
      throw new Error(
        `This ServiceWorker speaks ${HTTP_LINK_PROTOCOL}, the page ${params.wire}. ` +
          "Reload the page so that both run the same version of @statewalker/webrun-http-browser.",
      );
    }

    const ctl = params.ctl ? rest.shift() : undefined;
    const up = params.up ? rest.shift() : undefined;
    const { streamTimeout, window } = this.options;
    const link = await connectHttpLink(down, { streamTimeout, window });
    const entry = new HandlerEntry(
      params.key,
      params.id ?? clientId ?? crypto.randomUUID(),
      params.owner ?? crypto.randomUUID(),
      params.meta,
      link,
      ctl,
      clientId,
      params.ownerLock,
    );
    if (up) {
      entry.closeUp = await serveHttpLink(up, (request) => this.dispatch(request), {
        streamTimeout,
      });
    }
    if (ctl) ctl.onmessage = (message) => this._onControl(entry, message.data as ControlMessage);
    if (params.ownerLock) {
      entry.stopWatch = watchLock(params.ownerLock, () => {
        this.log("[owner lost]", entry.key, entry.id);
        this._close(entry, new LinkLostError(HANDLER_LOST_MESSAGE));
      });
    }
    this._add(entry);
    await this._routerHeld;
    return { accepted: HTTP_LINK_PROTOCOL, routerLock: this.routerLock };
  }

  private _add(entry: HandlerEntry): void {
    this._vacant.delete(entry.key);
    const replaced = this.table.add(entry);
    if (replaced && replaced !== entry) {
      void this._retire(replaced, this.options.handoverMs ?? 5_000, false);
    }
    void this._claim(entry.key);
    if (entry.ownerLock) this._watchLiveness();
  }

  /**
   * The backup of the owner-lock watches: every `livenessCheckMs`, drops the
   * handlers whose owner lock is no longer held. Runs only while some handler
   * has an owner lock, and keeps nothing awake: a timer is not an event.
   */
  private _watchLiveness(): void {
    const period = this.options.livenessCheckMs ?? 5_000;
    if (this._livenessTimer || period <= 0) return;
    this._livenessTimer = setInterval(async () => {
      const watched = this.table.entries().filter((entry) => entry.ownerLock);
      if (watched.length === 0) {
        clearInterval(this._livenessTimer);
        this._livenessTimer = undefined;
        return;
      }
      const held = await heldLockNames();
      if (!held) return;
      for (const entry of watched) {
        if (entry.ownerLock && !held.has(entry.ownerLock) && this.table.remove(entry)) {
          this.log("[owner gone]", entry.key, entry.id);
          this._close(entry, new LinkLostError(HANDLER_LOST_MESSAGE), false);
        }
      }
    }, period);
  }

  /** The entry a drain or detach names, if its owner token still matches. */
  private _find({ key, id, owner }: DrainParams): HandlerEntry | undefined {
    const entry = this.table.get(key, id);
    return entry && entry.owner === owner ? entry : undefined;
  }

  /**
   * Stops routing to `entry`, lets its requests in flight run for up to `ms`,
   * then closes it. Requests that arrive meanwhile wait for the next owner.
   */
  private async _retire(entry: HandlerEntry, ms: number, inTable = true): Promise<void> {
    entry.draining = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      entry.link.whenIdle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
    this._close(entry, new LinkLostError("The handler was drained"), inTable);
  }

  private _close(entry: HandlerEntry, reason: Error, inTable = true): void {
    if (inTable) this.table.remove(entry);
    entry.stopWatch();
    entry.sockets.failAll(reason);
    void entry.link.close(reason);
    void entry.closeUp?.().catch(() => {});
    if (entry.ctl) {
      entry.ctl.onmessage = null;
      entry.ctl.close();
    }
  }

  /**
   * The handler for `request`: picked by `route` among the live handlers of
   * its key, waiting for one when there is none.
   */
  private async _acquire(
    request: Request,
    key: string,
  ): Promise<HandlerEntry | typeof TIMED_OUT | undefined> {
    const deadline = Date.now() + (this.options.attachTimeoutMs ?? 15_000);
    const picked = await this._pick(request, key);
    if (picked) return picked;
    if (this.table.all(key).length === 0) {
      const vacantUntil = this._vacant.get(key) ?? 0;
      // The last handler was drained: wait for the next owner.
      if (vacantUntil > Date.now()) return await this._waitToPick(request, key, vacantUntil);
      if (!this.serves(key)) return undefined;
      // Nothing attached for a key this worker served: it may have restarted
      // and lost its links. Ask the pages for them.
      await this._askForLinks(key);
      const relinked = await this._pick(request, key);
      if (relinked) return relinked;
      // Nobody came back: the key's handlers are gone.
      if (this.table.all(key).length === 0) return undefined;
    }
    // A hand-over (every handler of the key drains), or `route` declined the
    // ones there are (it waits for one in particular): wait until a handler
    // it accepts attaches, not just the next one.
    return await this._waitToPick(request, key, deadline);
  }

  /** Waits for attaches until `route` accepts a handler, or `until` passes. */
  private async _waitToPick(
    request: Request,
    key: string,
    until: number,
  ): Promise<HandlerEntry | typeof TIMED_OUT> {
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) return TIMED_OUT;
      // In steps of at most a second: an attach between the last pick and
      // this wait is then noticed at the next step rather than missed.
      // A handler that attached since the last pick counts at once; when route
      // declined the live ones, only a new attach can change its answer.
      await this.table.waitFor(key, Math.min(left, 1_000), this.table.live(key).length > 0);
      const picked = await this._pick(request, key);
      if (picked) return picked;
    }
  }

  private async _pick(request: Request, key: string): Promise<HandlerEntry | undefined> {
    let live = this.table.live(key);
    // Without Web Locks there is no owner lock: check the page is still there.
    for (const entry of live) {
      if (entry.ownerLock || !entry.clientId) continue;
      if (!(await this._sw.clients.get(entry.clientId))) {
        this._close(entry, new LinkLostError(HANDLER_LOST_MESSAGE));
      }
    }
    live = this.table.live(key);
    if (live.length === 0) return undefined;
    const route = this.options.route ?? leastInflightRoute;
    return route(request, key, live);
  }

  /**
   * Asks every window to attach its links again, and waits until a handler
   * for `key` is back, every window answered, or `relinkTimeoutMs` passed.
   * At most one round per key every 10 s: a key whose tab is simply gone
   * should not cost every request the wait.
   */
  private _askForLinks(key = ""): Promise<void> {
    const round = this._relinkRounds.get(key);
    // Requests arriving during a round wait for the same round; after it, a
    // key whose tab is simply gone does not cost every request the wait.
    if (round && Date.now() - round.at < 10_000) return round.done;
    const done = this._linkRound(key);
    this._relinkRounds.set(key, { at: Date.now(), done });
    return done;
  }

  private async _linkRound(key: string): Promise<void> {
    const timeout = this.options.relinkTimeoutMs ?? 3_000;
    const windows = await this._sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    this.log("[need-links]", key, windows.length);
    const params: NeedLinksParams = { routerLock: this.routerLock };
    const pending = new Set(windows);
    const answered = Promise.allSettled(
      windows.map((client) =>
        callChannel(client, NEED_LINKS_CALL, params).then(() => pending.delete(client)),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeout);
    });
    // Every window answering is the end of the round; a window without this
    // package never answers, which is what the timeout is for.
    await Promise.race([answered, timedOut]);
    clearTimeout(timer);
    // The windows that did not answer may run version 1 of this package,
    // which re-links when asked the way version 1's worker asked.
    for (const client of pending) this._askLegacyPage(client);
  }

  /** Asks a version-1 page for a fresh port, as version 1's worker did. */
  private _askLegacyPage(client: Client): void {
    const channel = new MessageChannel();
    callChannel<AttachParams>(client, ATTACH_CALL, {}, channel.port2).then(
      (info) => {
        if (!info?.key || info.wire !== undefined) return;
        const link = trackedLink(
          (request) => sendHttpRequest(channel.port1, request),
          () => channel.port1.close(),
        );
        this._add(
          new HandlerEntry(
            info.key,
            client.id,
            client.id,
            undefined,
            link,
            undefined,
            client.id,
            undefined,
          ),
        );
      },
      () => channel.port1.close(),
    );
  }

  private _onControl(entry: HandlerEntry, message: ControlMessage): void {
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "ws-accept":
        // Too late (the caller gave up): close the port, or the handler's
        // socket lingers until its heartbeat notices.
        if (!entry.sockets.settle(message.id, { port: message.port, protocol: message.protocol })) {
          message.port.close();
        }
        return;
      case "ws-refuse":
        entry.sockets.fail(message.id, new Error(message.message));
        return;
      case "ws-open":
        // A handler opens a socket to another handler, through this router.
        this.connectWebSocket(
          message.url,
          message.protocols,
          this._socketHeaders(message.headers, "handler"),
        ).then(
          ({ port, protocol }) =>
            entry.ctl?.postMessage(
              { t: "ws-opened", id: message.id, protocol, port } satisfies ControlMessage,
              [port],
            ),
          (error) =>
            entry.ctl?.postMessage({
              t: "ws-failed",
              id: message.id,
              message: errorMessage(error),
            } satisfies ControlMessage),
        );
        return;
    }
  }

  private _isOwnClient(event: MessageEvent): boolean {
    const source = event.source as Client | null;
    if (!source?.url) return false;
    try {
      return new URL(source.url).origin === this._sw.location.origin;
    } catch {
      return false;
    }
  }

  private async _claim(key: string): Promise<void> {
    if (!key || this.claimedKeys.has(key)) return;
    this.claimedKeys.add(key);
    try {
      await set("claimedKeys", [...this.claimedKeys].sort());
    } catch (error) {
      this.log("[claimedKeys] not stored", error);
    }
  }

  private async _restoreClaimedKeys(): Promise<void> {
    const stored = ((await get<string[]>("claimedKeys")) ?? []) as string[];
    for (const key of stored) this.claimedKeys.add(key);
  }
}

/**
 * Starts the same-origin dispatcher in a ServiceWorker. Returns a function
 * that stops it.
 */
export function startHttpDispatcher(options: SwHttpDispatcherOptions): () => void {
  if (options.handleFetch === false) {
    throw new Error(
      "startHttpDispatcher: handleFetch: false needs a dispatcher to call handleFetch on; " +
        "construct it instead: new SwHttpDispatcher({ self, handleFetch: false }).start()",
    );
  }
  const dispatcher = new SwHttpDispatcher(options);
  dispatcher.start();
  return () => {
    void dispatcher.stop();
  };
}
