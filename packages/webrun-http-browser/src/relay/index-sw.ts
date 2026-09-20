import { HttpError } from "@statewalker/webrun-http-streams";
import { get, set } from "idb-keyval";
import { callChannel, handleChannelCalls } from "../core/data-calls.js";
import { newRegistry } from "../core/registry.js";
import { handleClaimRequests } from "../core/service-worker-control.js";
import { sendHttpRequest } from "../http/http-send-recieve.js";
import { type MountSpec, type MountTable, newMountTable } from "./mount-table.js";
import { splitServiceUrl } from "./split-service-url.js";

/** What the registry keeps per service key. */
export interface RegisteredClient {
  clientId: string;
  /** Where the service is mounted. Absent means `/~<key>/`, as before mounts. */
  path?: string;
}

/**
 * One stored registry entry, whatever shape it is on disk.
 *
 * BEFORE MOUNTS THE VALUE WAS A BARE CLIENT ID. A browser that ran the earlier
 * worker still holds that shape, and reading it as an object would drop the id
 * and quietly unregister every service the visitor had.
 */
export function readStoredEntry(value: unknown): RegisteredClient | undefined {
  if (typeof value === "string") return { clientId: value };
  if (typeof value !== "object" || value === null) return undefined;
  const { clientId, path } = value as { clientId?: unknown; path?: unknown };
  if (typeof clientId !== "string" || clientId === "") return undefined;
  return typeof path === "string" ? { clientId, path } : { clientId };
}

/**
 * Which service, if any, should answer `url`.
 *
 * `undefined` means NOT THE RELAY'S, and the caller must not call
 * `respondWith`: the request then goes to the network, which is how a host
 * keeps serving its own files from its own origin. Answering 404 here instead
 * would make a root mount fatal.
 */
export function resolveServiceKey(
  url: URL,
  table: MountTable,
  selfOrigin: string,
): string | undefined {
  // Another origin's resource is the network's business, as in any page.
  if (url.origin !== selfOrigin) return undefined;
  const mounted = table.find(url);
  if (mounted != null) return mounted;
  const { key } = splitServiceUrl(url);
  return key === "" ? undefined : key;
}

/**
 * Waits for the mount table to be restored from the registry before routing
 * `url` — but a restore failure must never wedge every fetch. `restored`
 * rejecting (blocked storage, quota, private-mode edge cases) would otherwise
 * propagate straight to `respondWith` on every request, including ones that
 * should reach the network, which breaks the one rule this file exists to
 * uphold. So: log the failure and route with whatever the in-memory table
 * already holds — possibly empty, never fatal.
 */
export async function resolveAfterRestore(
  restored: Promise<void>,
  url: URL,
  table: MountTable,
  selfOrigin: string,
): Promise<string | undefined> {
  try {
    await restored;
  } catch (error) {
    console.error("[relay] failed to restore mounts from the registry", error);
  }
  return resolveServiceKey(url, table, selfOrigin);
}

/**
 * What REGISTER does to the mount table: set it when `path` is given, or
 * remove any earlier mount when it is not. A path-less re-registration
 * reverts a service to `/~<key>/` addressing, and a stale prefix left behind
 * would keep routing requests to a mount that no longer exists.
 */
export function applyRegisteredMount(
  table: MountTable,
  key: string,
  path: string | undefined,
): void {
  if (path != null) {
    table.set(key, { path });
  } else {
    table.remove(key);
  }
}

export interface RelayServiceWorkerOptions {
  /** A fixed table, for a host that knows its services at build time. */
  mounts?: Array<{ key: string } & MountSpec>;
  /** Paths the relay never claims. Checked before the table. */
  exclude?: (url: URL) => boolean;
  /** Refuse a registration from the wrong client. Default: everyone may. */
  canRegister?: (client: Client, key: string) => boolean | Promise<boolean>;
  /** Default `"last-wins"`, the behaviour before this option existed. */
  takeover?: "first-wins" | "last-wins";
  /** Stamp headers on responses the relay makes. Not applied to network fetches. */
  decorateResponse?: (response: Response, request: Request) => Response;
}

/**
 * May `candidateId` take the key?
 *
 * `last-wins` is what the relay has always done and stays the default. With
 * `first-wins`, a LIVE holder keeps its key: on an origin whose name is
 * guessable, a second page proves nothing by existing. A holder that reloaded
 * is no longer live, so a host's own re-registration is never blocked.
 */
export function mayRegister(args: {
  current?: RegisteredClient;
  candidateId: string;
  isCurrentLive: boolean;
  takeover: "first-wins" | "last-wins";
}): boolean {
  if (args.takeover === "last-wins") return true;
  if (args.current == null || !args.isCurrentLive) return true;
  return args.current.clientId === args.candidateId;
}

/**
 * Boots the relay ServiceWorker: routes fetches shaped `<origin>/~<key>/…` to
 * the client that registered `key`, and exposes REGISTER/UNREGISTER/CONNECT
 * channel calls used by the page-side relay client.
 */
export function startRelayServiceWorker(
  self: ServiceWorkerGlobalScope,
  options: RelayServiceWorkerOptions = {},
): () => void {
  const [register, clear] = newRegistry();
  const mounts = newMountTable({ exclude: options.exclude });
  for (const { key, ...spec } of options.mounts ?? []) mounts.set(key, spec);
  const takeover = options.takeover ?? "last-wins";

  if (typeof self.skipWaiting === "function") {
    self.addEventListener("install", (e: ExtendableEvent) => {
      e.waitUntil(self.skipWaiting());
    });
  }

  if (self.clients && typeof self.clients.claim === "function") {
    self.addEventListener("activate", (e: ExtendableEvent) => {
      e.waitUntil(self.clients.claim());
    });
  }

  const clientsRegistry = newClientsRegistry({ self });

  // A RESTARTED WORKER HAS AN EMPTY TABLE AND A FULL DATABASE. The registry
  // survives in IndexedDB; the mounts are in memory, so they must be read back
  // or the first fetch after a restart finds nothing mounted.
  const restored = clientsRegistry.restoreMounts(mounts);

  // Pages bridge to `registration.active` when uncontrolled, so they do not
  // need this; it is here so any page of this origin can ask for control.
  register(handleClaimRequests(self));

  register(
    handleChannelCalls(self, "REGISTER", async (event, data) => {
      const source = event.source as Client | null;
      if (!source) return false;
      const { key, path } = data as { key: string; path?: string };

      if (options.canRegister != null && !(await options.canRegister(source, key))) {
        throw new Error(`this client may not register "${key}"`);
      }

      // `last-wins` -- the untouched default -- must cost exactly what it did
      // before this option existed: no registry lookup beyond `addClient`'s
      // own. Only `first-wins` needs to know who currently holds the key and
      // whether they are still live, so only it pays for finding out.
      if (takeover === "first-wins") {
        const current = await clientsRegistry.getMount(key);
        const isCurrentLive = current != null && (await clientsRegistry.getClient(key)) != null;
        if (!mayRegister({ current, candidateId: source.id, isCurrentLive, takeover })) {
          throw new Error(`"${key}" is already served by another client`);
        }
      }

      const added = await clientsRegistry.addClient(key, source, path);
      applyRegisteredMount(mounts, key, path);
      return added;
    }),
  );
  register(
    handleChannelCalls(self, "UNREGISTER", async (_event, data) => {
      const { key } = data as { key: string };
      mounts.remove(key);
      return await clientsRegistry.removeClient(key);
    }),
  );
  register(
    handleChannelCalls(self, "CONNECT", async (_event, data, port: MessagePort) => {
      const { key } = data as { key: string };
      const client = await clientsRegistry.getClient(key);
      if (!client) throw new Error(`Target client was not found. Target key: "${key}".`);
      return await callChannel<boolean>(client, "CONNECT", data, port);
    }),
  );

  const fetchListener = (event: FetchEvent) => {
    const request = event.request;
    const url = new URL(request.url);

    event.respondWith(
      (async (): Promise<Response> => {
        const key = await resolveAfterRestore(restored, url, mounts, self.location.origin);
        if (key == null) return await fetch(request);

        const params = splitServiceUrl(url);
        try {
          const channel = new MessageChannel();
          const client = await clientsRegistry.getClient(key);
          if (!client) throw HttpError.errorResourceGone(params);
          const data = { type: "http", key };
          const accepted = await callChannel<boolean>(client, "CONNECT", data, channel.port2);
          if (!accepted) throw HttpError.errorForbidden(params);
          const response = await sendHttpRequest(channel.port1, request);
          return options.decorateResponse?.(response, request) ?? response;
        } catch (error) {
          const httpError = HttpError.fromError(error);
          const errorOptions = httpError.getResponseOptions(params);
          const errorResponse = new Response(JSON.stringify(errorOptions), {
            status: httpError.status ?? 500,
            statusText: httpError.statusText ?? "Internal Error",
            headers: { "Content-Type": "application/json" },
          });
          return options.decorateResponse?.(errorResponse, request) ?? errorResponse;
        }
      })(),
    );
  };
  self.addEventListener("fetch", fetchListener);
  register(() => self.removeEventListener("fetch", fetchListener));

  return clear;
}

interface ClientsRegistryOptions {
  self: ServiceWorkerGlobalScope;
  key?: string;
}

interface ClientsRegistry {
  addClient(clientKey: string, client: Client, path?: string): Promise<boolean>;
  removeClient(clientKey: string): Promise<boolean>;
  getClient(clientKey: string): Promise<Client | undefined>;
  getMount(clientKey: string): Promise<RegisteredClient | undefined>;
  restoreMounts(table: MountTable): Promise<void>;
}

function newClientsRegistry({ self, key = "clientsIds" }: ClientsRegistryOptions): ClientsRegistry {
  let _index: Record<string, RegisteredClient> | undefined;

  async function loadClientsIndex(): Promise<Record<string, RegisteredClient>> {
    if (!_index) {
      const entries = ((await get<Array<[string, unknown]>>(key)) ?? []) as Array<
        [string, unknown]
      >;
      _index = {};
      for (const [clientKey, value] of entries) {
        const entry = readStoredEntry(value);
        if (entry) _index[clientKey] = entry;
      }
    }
    return _index;
  }

  async function storeClientsIndex(): Promise<Record<string, RegisteredClient>> {
    const index = await loadClientsIndex();
    await set(key, Object.entries(index));
    return index;
  }

  async function addClient(clientKey: string, client: Client, path?: string): Promise<boolean> {
    const index = await loadClientsIndex();
    const current = index[clientKey];
    if (current?.clientId === client.id && current.path === path) return false;
    index[clientKey] = path == null ? { clientId: client.id } : { clientId: client.id, path };
    await storeClientsIndex();
    return true;
  }

  async function removeClient(clientKey: string): Promise<boolean> {
    const index = await loadClientsIndex();
    if (!(clientKey in index)) return false;
    delete index[clientKey];
    await storeClientsIndex();
    return true;
  }

  async function getMount(clientKey: string): Promise<RegisteredClient | undefined> {
    const index = await loadClientsIndex();
    return index[clientKey];
  }

  async function restoreMounts(table: MountTable): Promise<void> {
    const index = await loadClientsIndex();
    for (const [clientKey, entry] of Object.entries(index)) {
      if (entry.path != null) table.set(clientKey, { path: entry.path });
    }
  }

  async function getClient(clientKey: string): Promise<Client | undefined> {
    const index = await loadClientsIndex();
    const entry = index[clientKey];
    if (!entry) return undefined;
    const client = await self.clients.get(entry.clientId);
    if (!client) {
      delete index[clientKey];
      await storeClientsIndex();
    }
    return client ?? undefined;
  }

  return { getClient, getMount, addClient, removeClient, restoreMounts };
}
