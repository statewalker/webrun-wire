import { get, set } from "idb-keyval";
import { callChannel, handleChannelCalls } from "../core/data-calls.js";
import { newRegistry } from "../core/registry.js";

export interface SwPortHandlerOptions {
  key: string;
  scope?: string;
  serviceWorkerUrl?: string;
  bindPort: (port: MessagePort) => void | Promise<void>;
}

interface ChannelInfo {
  key: string;
  clientId?: string;
  port?: MessagePort;
}

/**
 * Page-side counterpart: registers a ServiceWorker and sets up a
 * MessageChannel with it, re-establishing the connection after SW wake-ups.
 */
export class SwPortHandler {
  readonly options: SwPortHandlerOptions;
  private _serviceWorkerUrl?: string;
  private _serviceWorker?: ServiceWorker;
  private _registrationPromise?: Promise<void>;
  private _cleanupRegistrations?: () => void;

  constructor(options: SwPortHandlerOptions) {
    this.options = options;
    if (!this.key) throw new Error("Key is not defined.");
    if (!this.scope) throw new Error("Scope is not defined");
  }

  get key(): string {
    return this.options.key;
  }

  get scope(): string {
    return this.options.scope ?? new URL("./", this.serviceWorkerUrl).pathname;
  }

  get rootUrl(): URL {
    return new URL(this.scope, import.meta.url);
  }

  get serviceWorkerUrl(): string {
    if (!this._serviceWorkerUrl) {
      const url = this.options.serviceWorkerUrl
        ? // A worker url is relative to the document that registers it, so it
          // is resolved against `location.href` like any other url a page
          // writes. Without the base, the root-relative form callers actually
          // use — `"/sw-worker.js"` — threw a bare `Invalid URL` naming
          // neither the option nor the value.
          resolveWorkerUrl(this.options.serviceWorkerUrl)
        : new URL("./index-sw.js", this.rootUrl);
      this._serviceWorkerUrl = `${url}`;
    }
    return this._serviceWorkerUrl;
  }

  protected async _newCommunicationChannel(): Promise<[MessagePort, MessagePort]> {
    const messageChannel = new MessageChannel();
    return [messageChannel.port1, messageChannel.port2];
  }

  protected async _setCommunicationPort(port: MessagePort): Promise<void> {
    await this.options.bindPort(port);
  }

  protected async _updateCommunicationChannel(): Promise<void> {
    if (!this._serviceWorker) return;
    const [port1, port2] = await this._newCommunicationChannel();
    await this._setCommunicationPort(port1);
    await callChannel(
      this._serviceWorker,
      "UPDATE_COMMUNICATION_PORT",
      this._getRegistrationInfo(),
      port2,
    );
  }

  protected _getRegistrationInfo(): ChannelInfo {
    return { key: this.key };
  }

  async start(): Promise<void> {
    if (!this._registrationPromise) {
      this._registrationPromise = (async () => {
        const [register, cleanup] = newRegistry();
        this._cleanupRegistrations = cleanup;
        register(() => {
          this._cleanupRegistrations = undefined;
        });
        const registration = await navigator.serviceWorker.register(this.serviceWorkerUrl, {
          scope: this.scope,
        });
        register(() => registration.unregister());

        register(
          handleChannelCalls(
            navigator.serviceWorker,
            "UPDATE_COMMUNICATION_PORT",
            async (_event, _params, port: MessagePort) => {
              await this._setCommunicationPort(port);
              return this._getRegistrationInfo();
            },
          ),
        );

        this._serviceWorker = await getServiceWorkerController();
        await awaitServiceWorkerActivation(this._serviceWorker);
        await this._updateCommunicationChannel();
      })();
    }
    return this._registrationPromise;
  }

  async stop(): Promise<void> {
    this._cleanupRegistrations?.();
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      try {
        await registration.unregister();
      } catch (error) {
        console.log("Service Worker registration failed: ", error);
      }
    }
  }
}

function getServiceWorkerController(): Promise<ServiceWorker> {
  return new Promise((resolve) => {
    const container = navigator.serviceWorker;
    if (container.controller) {
      resolve(container.controller);
      return;
    }
    const onChange = () => {
      if (!container.controller) return;
      resolve(container.controller);
      container.removeEventListener("controllerchange", onChange);
    };
    container.addEventListener("controllerchange", onChange);
  });
}

function awaitServiceWorkerActivation(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    if (worker.state === "activated") {
      resolve();
      return;
    }
    const onStateChange = () => {
      if (worker.state !== "activated") return;
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

export interface SwPortDispatcherOptions {
  self: ServiceWorkerGlobalScope;
  log?: (...args: unknown[]) => void;
}

/**
 * ServiceWorker-side counterpart: maintains an index of connected clients keyed by
 * clientId, persisted in IndexedDB so it can reclaim ports across SW restarts.
 */
export class SwPortDispatcher {
  readonly self: ServiceWorkerGlobalScope;
  readonly log: (...args: unknown[]) => void;
  readonly handlersIndex = new Map<string, ChannelInfo>();
  /**
   * Set of keys that were registered at some point on this SW (sticky —
   * survives client closures + SW wake-ups via IndexedDB). Lets the fetch
   * handler distinguish "site URL whose owner is gone → 404" from
   * "unknown URL under scope → pass through to the network".
   */
  readonly claimedKeys = new Set<string>();
  private _cleanup?: () => void;
  private _activationPromise?: Promise<void>;

  constructor({ self, log = () => {} }: SwPortDispatcherOptions) {
    this.self = self;
    this.log = log;
  }

  get scope(): string {
    return `${new URL("./", this.self.location.href)}`;
  }

  /**
   * Look up the active channel for a key. Returns `undefined` when there
   * is no registration (or the registering client has gone away — stale
   * entries are pruned in place).
   */
  async loadChannelInfo(key: string): Promise<ChannelInfo | undefined> {
    await this._checkActivation();
    for (const channelInfo of this.handlersIndex.values()) {
      if (channelInfo.key !== key) continue;
      const clientId = channelInfo.clientId;
      if (!clientId) continue;
      const client = await this.self.clients.get(clientId);
      if (!client) {
        // Owner tab closed: drop the stale entry and keep scanning for
        // another client that still claims this key.
        this.handlersIndex.delete(clientId);
        continue;
      }
      return channelInfo;
    }
    return undefined;
  }

  /** Whether `key` has ever been registered on this SW. */
  isClaimedKey(key: string): boolean {
    return this.claimedKeys.has(key);
  }

  start(): void {
    this._cleanup = handleChannelCalls(
      this.self,
      "UPDATE_COMMUNICATION_PORT",
      async (event, channelInfo, port: MessagePort) => {
        const client = event.source as Client | null;
        const clientId = client?.id;
        this.log("[UPDATE_COMMUNICATION_PORT]", clientId, channelInfo);
        await this._updateChannelInfo({ ...(channelInfo as ChannelInfo), port, clientId });
        return { ...(channelInfo as ChannelInfo) };
      },
    );

    this.self.addEventListener("install", (event) => {
      this.log("Skip waiting on install.", event);
      this.self.skipWaiting();
    });

    this.self.addEventListener("activate", (event) => {
      this.log("Claim control over all clients.", event);
      event.waitUntil(
        (async () => {
          await this.self.clients.claim();
          await this._checkActivation();
        })(),
      );
    });
  }

  async stop(): Promise<void> {
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = undefined;
    }
  }

  private _checkActivation(): Promise<void> {
    if (!this._activationPromise) {
      this._activationPromise = this._activate();
    }
    return this._activationPromise;
  }

  private async _activate(): Promise<void> {
    this.log("[checkActivation]");
    const clientsIndex = await this._loadClientIds();
    for (const [clientId, client] of clientsIndex.entries()) {
      const messageChannel = new MessageChannel();
      const port = messageChannel.port1;
      const channelInfo = await callChannel<ChannelInfo>(
        client,
        "UPDATE_COMMUNICATION_PORT",
        {},
        messageChannel.port2,
      );
      await this._updateChannelInfo({ ...channelInfo, port, clientId });
    }
  }

  private async _updateChannelInfo(channelInfo: ChannelInfo): Promise<void> {
    this.log("[updateClientInfo]", channelInfo);
    if (!channelInfo.clientId) return;
    this.handlersIndex.set(channelInfo.clientId, channelInfo);
    if (channelInfo.key && !this.claimedKeys.has(channelInfo.key)) {
      this.claimedKeys.add(channelInfo.key);
      await set("claimedKeys", [...this.claimedKeys].sort());
    }
    await this._updateClientIds([]);
  }

  private async _loadClientIds(): Promise<Map<string, Client>> {
    const storedKeys = ((await get<string[]>("claimedKeys")) ?? []) as string[];
    for (const key of storedKeys) this.claimedKeys.add(key);
    const stored = ((await get<string[]>("clientIds")) ?? []) as string[];
    return await this._updateClientIds(new Set(stored));
  }

  private async _updateClientIds(clientIds: Iterable<string>): Promise<Map<string, Client>> {
    const ids = new Set(clientIds);
    for (const clientId of this.handlersIndex.keys()) ids.add(clientId);
    const index = new Map<string, Client>();
    for (const clientId of ids) {
      const client = await this.self.clients.get(clientId);
      if (client) index.set(clientId, client);
      else this.handlersIndex.delete(clientId);
    }
    await set("clientIds", [...index.keys()].sort());
    return index;
  }
}

/**
 * Resolve a `serviceWorkerUrl` option the way a page would: relative to the
 * current document. Absolute urls pass through untouched. A url that cannot
 * be resolved is reported with the option name and the offending value,
 * because the raw `TypeError: Failed to construct 'URL': Invalid URL` says
 * neither.
 */
function resolveWorkerUrl(serviceWorkerUrl: string): URL {
  const base = globalThis.location?.href;
  try {
    return new URL(serviceWorkerUrl, base);
  } catch (error) {
    throw new Error(
      `Invalid serviceWorkerUrl: ${JSON.stringify(serviceWorkerUrl)}` +
        (base ? ` (relative to ${base})` : " (no document to resolve it against)"),
      { cause: error },
    );
  }
}
