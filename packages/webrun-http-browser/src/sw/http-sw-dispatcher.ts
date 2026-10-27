/// <reference lib="webworker" />

import { get, set } from "idb-keyval";
import { callChannel, handleChannelCalls, withTransfer } from "../core/data-calls.js";
import { handleClaimRequests } from "../core/service-worker-control.js";
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

export interface SwHttpDispatcherOptions {
  self: ServiceWorkerGlobalScope;
  log?: (...args: unknown[]) => void;
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
 * A url `<scope>/<key>/...` belongs to the handlers of `key`. Of those, the
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
  readonly self: ServiceWorkerGlobalScope;
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
    this.log = options.log ?? (() => {});
    if (locksAvailable()) this.routerLock = newLockName("webrun-http-router");
  }

  get scope(): string {
    return `${new URL("./", this.self.location.href)}`;
  }

  /** The key `url` belongs to: its first path segment under the scope. */
  keyOf(url: string | URL): string | undefined {
    const href = `${url}`;
    const scope = this.scope;
    if (!href.startsWith(scope)) return undefined;
    const key = href
      .substring(scope.length)
      .replace(/[?#].*$/, "")
      .split("/")[0];
    return key ? decodeURIComponent(key) : undefined;
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
    const self = this.self;
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
        const { url, protocols } = params as { url: string; protocols?: string[] };
        const connection = await this.connectWebSocket(url, protocols ?? []);
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
    const onFetch = (event: FetchEvent) => this._onFetch(event);
    self.addEventListener("install", onInstall);
    self.addEventListener("activate", onActivate);
    self.addEventListener("fetch", onFetch);
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
   * handler its key routes to. A url outside the scope, or of a key this
   * worker never served, goes to the network.
   */
  async dispatch(request: Request): Promise<Response> {
    const key = this.keyOf(request.url);
    if (key === undefined) return await fetch(request);
    await this._restored.catch(() => {});
    const entry = await this._acquire(request, key);
    if (entry === TIMED_OUT) {
      return new Response(null, {
        status: 503,
        statusText: "Service Unavailable (no handler attached in time)",
      });
    }
    if (!entry) {
      if (!this.serves(key)) return await fetch(request);
      // Key was served at some point but has no live handler now (its tab
      // closed). 404 rather than the network: a dev server's SPA fallback
      // would serve the app shell for every site url and stale tabs would
      // keep resurrecting registrations.
      return new Response(null, { status: 404, statusText: "Not Found (no active handler)" });
    }
    try {
      return await entry.link.send(request);
    } catch (error) {
      this.log("[dispatch] failed", key, error);
      return new Response(errorMessage(error), {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
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
    if (key === undefined) throw new Error(`${url} is outside this ServiceWorker's scope`);
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

  private _onFetch(event: FetchEvent): void {
    const request = event.request;
    const key = this.keyOf(request.url);
    // Outside the scope: not ours. No `respondWith`, so the browser does the
    // request exactly as it would without a worker.
    if (key === undefined) return;
    if (this._restoreSettled) {
      if (!this.serves(key)) return;
      event.respondWith(this.dispatch(request));
      return;
    }
    // Before the stored keys are read there is nothing to decide on, and
    // `respondWith` cannot be called after an await: claim the request, and
    // re-issue it if it turns out to be nobody's.
    event.respondWith(
      (async () => {
        await this._restored.catch(() => {});
        if (!this.serves(key)) return await fetch(request);
        return await this.dispatch(request);
      })(),
    );
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
    const streamTimeout = this.options.streamTimeout;
    const link = await connectHttpLink(down, { streamTimeout });
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
    const picked = await this._pick(request, key);
    if (picked) return picked;
    if (this.table.all(key).length > 0) {
      // A hand-over: every handler of the key drains, or `route` declined
      // them all. Wait for the next owner.
      const attached = await this.table.waitFor(
        key,
        this.options.attachTimeoutMs ?? 15_000,
        this.table.live(key).length > 0,
      );
      return attached ? ((await this._pick(request, key)) ?? TIMED_OUT) : TIMED_OUT;
    }
    const vacantUntil = this._vacant.get(key) ?? 0;
    if (vacantUntil > Date.now()) {
      // The last handler was drained: wait for the next owner.
      const attached = await this.table.waitFor(key, vacantUntil - Date.now());
      return attached ? ((await this._pick(request, key)) ?? TIMED_OUT) : TIMED_OUT;
    }
    if (!this.serves(key)) return undefined;
    // Nothing attached for a key this worker served: it may have restarted
    // and lost its links. Ask the pages for them.
    await this._askForLinks(key);
    return await this._pick(request, key);
  }

  private async _pick(request: Request, key: string): Promise<HandlerEntry | undefined> {
    let live = this.table.live(key);
    // Without Web Locks there is no owner lock: check the page is still there.
    for (const entry of live) {
      if (entry.ownerLock || !entry.clientId) continue;
      if (!(await this.self.clients.get(entry.clientId))) {
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
    const windows = await this.self.clients.matchAll({ type: "window", includeUncontrolled: true });
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
        this.connectWebSocket(message.url, message.protocols).then(
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
      return new URL(source.url).origin === this.self.location.origin;
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
  const dispatcher = new SwHttpDispatcher(options);
  dispatcher.start();
  return () => {
    void dispatcher.stop();
  };
}
