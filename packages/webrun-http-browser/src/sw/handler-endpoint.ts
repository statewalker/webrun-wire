import { errorMessage } from "../link/errors.js";
import {
  connectHttpLink,
  type HttpLink,
  type HttpLinkOptions,
  LinkLostError,
  serveHttpLink,
} from "../link/http-link.js";
import { watchLock } from "../link/locks.js";
import { PortRendezvous } from "../link/rendezvous.js";
import type { WebSocketConnection } from "../ws/client.js";
import { serveWebSocketUpgrade } from "../ws/upgrade.js";
import type { ControlMessage } from "./protocol.js";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface HandlerEndpointOptions extends HttpLinkOptions {
  /** Asks whoever attaches this endpoint to do it again (its links died). */
  requestRelink?: () => void;
  /** Pokes the ServiceWorker so that it stays awake while calls are in flight. */
  keepAlive?: () => void;
  /** Period of `keepAlive` while calls are in flight, in ms. Default 20 s. */
  keepAliveMs?: number;
  /** How often a waiting call asks for a link again, in ms. Default 2 s. */
  relinkRetryMs?: number;
  /** How long a call waits for a link before failing, in ms. Default 30 s. */
  relinkTimeoutMs?: number;
  /** How long a socket waits for the far handler's answer, in ms. Default 15 s. */
  wsConnectTimeoutMs?: number;
  /**
   * How long a link replaced by a newer one of the same router keeps serving
   * what it has, in ms. The ServiceWorker closes it first, once its requests
   * are done; this only bounds a link it forgot. Default 30 s.
   */
  supersededLinkMs?: number;
}

export interface EndpointLinkPorts {
  down: MessagePort;
  ctl?: MessagePort;
  up?: MessagePort;
}

interface LiveLink {
  key: string;
  routerLock?: string;
  ctl?: MessagePort;
  up?: HttpLink;
  closeDown: () => Promise<void>;
  stopWatch: () => void;
  /** A newer link of the same key took over: finish, take nothing new. */
  superseded?: boolean;
}

/** The message calls through a lost ServiceWorker fail with. */
export const ROUTER_LOST_MESSAGE = "The ServiceWorker was lost while this call was in flight";

/**
 * The handler's end of its links to the ServiceWorker, the same in a page and
 * in a Dedicated Worker.
 *
 * - Serves `handler` on each link's `down` port, and answers WebSocket
 *   upgrades arriving on its `ctl` port by running them through `handler`.
 * - Sends requests through the router on `up` (`fetch`) and opens sockets to
 *   other handlers over `ctl` (`connectWebSocket`).
 * - Watches the ServiceWorker's router lock. When the ServiceWorker dies, the
 *   links made for it are dropped: calls in flight on them fail with
 *   `LinkLostError` ("may or may not have been applied") instead of hanging,
 *   and new calls wait for a link, asking for one (`requestRelink`) every
 *   `relinkRetryMs` until it comes.
 * - While calls are in flight, calls `keepAlive` every `keepAliveMs`: port
 *   messages are not events, so without it the browser may stop the
 *   ServiceWorker in the middle of a long call.
 */
export class HandlerEndpoint {
  private readonly _links = new Set<LiveLink>();
  private _waiters: Array<() => void> = [];
  private readonly _sockets = new PortRendezvous<WebSocketConnection>("o");
  private _keepAliveTimer?: ReturnType<typeof setInterval>;
  private _closed = false;

  constructor(
    readonly handler: FetchHandler,
    readonly options: HandlerEndpointOptions = {},
  ) {}

  /** Whether any link is live. */
  get linked(): boolean {
    return this._links.size > 0;
  }

  /** Installs a fresh link made for the router holding `routerLock`. */
  async link(key: string, ports: EndpointLinkPorts, routerLock?: string): Promise<void> {
    if (this._closed) {
      for (const port of Object.values(ports)) port?.close();
      return;
    }
    const closeDown = await serveHttpLink(ports.down, this.handler, this.options);
    const up = ports.up ? await connectHttpLink(ports.up, this.options) : undefined;
    const link: LiveLink = { key, routerLock, ctl: ports.ctl, up, closeDown, stopWatch: () => {} };
    if (ports.ctl) {
      ports.ctl.onmessage = (event) => this._onControl(link, event.data as ControlMessage);
    }
    // Each watch drops only the links made for its own router, so a link made
    // by the next router is never dropped by the death of the previous one.
    if (routerLock) link.stopWatch = watchLock(routerLock, () => this._routerLost(routerLock));
    for (const old of [...this._links]) {
      if (old.key !== key) continue;
      if (old.routerLock !== routerLock) {
        // Made for another router: it belongs to a dead ServiceWorker,
        // whatever its lock watch has not noticed yet.
        void this._drop(old, new LinkLostError(ROUTER_LOST_MESSAGE));
      } else if (!old.superseded) {
        // Same router: the ServiceWorker lets it finish its requests in
        // flight, so it keeps serving them; it only stops being picked.
        old.superseded = true;
        setTimeout(() => void this._drop(old), this.options.supersededLinkMs ?? 30_000);
      }
    }
    this._links.add(link);
    for (const wake of this._waiters.splice(0)) wake();
  }

  /** Drops the links attached under `key` (all of them without a key). */
  async unlink(key?: string, reason?: Error): Promise<void> {
    const dropped = [...this._links].filter((link) => key === undefined || link.key === key);
    await Promise.all(dropped.map((link) => this._drop(link, reason)));
  }

  /** The routers this endpoint has live links for. */
  routerLocks(): Set<string | undefined> {
    return new Set([...this._links].map((link) => link.routerLock));
  }

  /**
   * Sends `request` through the ServiceWorker's router, as if the browser had
   * fetched it: it reaches the handler its url routes to.
   */
  async fetch(request: Request): Promise<Response> {
    const link = await this._linkWith("up");
    this._startKeepAlive();
    return await (link.up as HttpLink).send(request);
  }

  /** Opens a socket to the handler `url` routes to, through the ServiceWorker. */
  async connectWebSocket(url: string, protocols: string[] = []): Promise<WebSocketConnection> {
    const link = await this._linkWith("ctl");
    const id = this._sockets.newId();
    const answer = this._sockets.wait(
      id,
      this.options.wsConnectTimeoutMs ?? 15_000,
      `the socket request for ${url}`,
    );
    link.ctl?.postMessage({ t: "ws-open", id, url, protocols } satisfies ControlMessage);
    return await answer;
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    await this.unlink(undefined, new LinkLostError("The handler was closed"));
    for (const wake of this._waiters.splice(0)) wake();
  }

  private async _drop(link: LiveLink, reason?: Error): Promise<void> {
    if (!this._links.delete(link)) return;
    link.stopWatch();
    await link.up?.close(reason);
    try {
      await link.closeDown();
    } catch {}
    if (link.ctl) {
      link.ctl.onmessage = null;
      link.ctl.close();
    }
  }

  private _routerLost(routerLock: string): void {
    const reason = new LinkLostError(ROUTER_LOST_MESSAGE);
    for (const link of [...this._links]) {
      if (link.routerLock === routerLock) void this._drop(link, reason);
    }
    this._sockets.failAll(reason);
  }

  /** A live link with `port`, waiting (and asking) for one when there is none. */
  private async _linkWith(port: "up" | "ctl"): Promise<LiveLink> {
    const find = () =>
      [...this._links]
        .filter((link) => !link.superseded)
        .reverse()
        .find((link) => (port === "up" ? link.up && !link.up.closed : link.ctl));
    const found = find();
    if (found) return found;
    const retryMs = this.options.relinkRetryMs ?? 2_000;
    const deadline = Date.now() + (this.options.relinkTimeoutMs ?? 30_000);
    while (!this._closed) {
      this.options.requestRelink?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, Math.min(retryMs, deadline - Date.now())));
        this._waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      const link = find();
      if (link) return link;
      if (Date.now() >= deadline) break;
    }
    throw new LinkLostError("No link to the ServiceWorker could be made for this call");
  }

  private _startKeepAlive(): void {
    if (this._keepAliveTimer || !this.options.keepAlive) return;
    this._keepAliveTimer = setInterval(() => {
      const inflight = [...this._links].reduce((sum, link) => sum + (link.up?.inflight ?? 0), 0);
      if (inflight === 0) {
        clearInterval(this._keepAliveTimer);
        this._keepAliveTimer = undefined;
        return;
      }
      this.options.keepAlive?.();
    }, this.options.keepAliveMs ?? 20_000);
  }

  private _onControl(link: LiveLink, message: ControlMessage): void {
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "ws-connect":
        void this._acceptSocket(link, message);
        return;
      case "ws-opened":
        if (!this._sockets.settle(message.id, { port: message.port, protocol: message.protocol })) {
          message.port.close();
        }
        return;
      case "ws-failed":
        this._sockets.fail(message.id, new Error(message.message));
        return;
    }
  }

  private async _acceptSocket(
    link: LiveLink,
    { id, url, protocols, headers }: Extract<ControlMessage, { t: "ws-connect" }>,
  ): Promise<void> {
    const ctl = link.ctl;
    if (!ctl) return;
    try {
      const result = await serveWebSocketUpgrade(this.handler, { url, protocols, headers });
      if (result.ok) {
        ctl.postMessage(
          {
            t: "ws-accept",
            id,
            protocol: result.protocol,
            port: result.port,
          } satisfies ControlMessage,
          [result.port],
        );
      } else {
        ctl.postMessage({
          t: "ws-refuse",
          id,
          status: result.status,
          message: result.message,
        } satisfies ControlMessage);
      }
    } catch (error) {
      ctl.postMessage({
        t: "ws-refuse",
        id,
        status: 500,
        message: errorMessage(error),
      } satisfies ControlMessage);
    }
  }
}
