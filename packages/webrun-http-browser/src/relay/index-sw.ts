import { HttpError } from "@statewalker/webrun-http-streams";
import { get, set } from "idb-keyval";
import { callChannel, handleChannelCalls } from "../core/data-calls.js";
import { newRegistry } from "../core/registry.js";
import { handleClaimRequests } from "../core/service-worker-control.js";
import { sendHttpRequest } from "../http/http-send-recieve.js";
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
 * Boots the relay ServiceWorker: routes fetches shaped `<origin>/~<key>/…` to
 * the client that registered `key`, and exposes REGISTER/UNREGISTER/CONNECT
 * channel calls used by the page-side relay client.
 */
export function startRelayServiceWorker(self: ServiceWorkerGlobalScope): () => void {
  const [register, clear] = newRegistry();

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

  // Pages bridge to `registration.active` when uncontrolled, so they do not
  // need this; it is here so any page of this origin can ask for control.
  register(handleClaimRequests(self));

  register(
    handleChannelCalls(self, "REGISTER", async (event, data) => {
      const source = event.source as Client | null;
      if (!source) return false;
      const { key, path } = data as { key: string; path?: string };
      return await clientsRegistry.addClient(key, source, path);
    }),
  );
  register(
    handleChannelCalls(self, "UNREGISTER", async (_event, data) => {
      const { key } = data as { key: string };
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
    const params = splitServiceUrl(request.url);
    const { key } = params;
    if (!key) return;

    event.respondWith(
      (async (): Promise<Response> => {
        try {
          const channel = new MessageChannel();
          const client = await clientsRegistry.getClient(key);
          if (!client) throw HttpError.errorResourceGone(params);
          const data = { type: "http", key };
          const accepted = await callChannel<boolean>(client, "CONNECT", data, channel.port2);
          if (!accepted) throw HttpError.errorForbidden(params);
          return await sendHttpRequest(channel.port1, request);
        } catch (error) {
          const httpError = HttpError.fromError(error);
          const options = httpError.getResponseOptions(params);
          return new Response(JSON.stringify(options), {
            status: httpError.status ?? 500,
            statusText: httpError.statusText ?? "Internal Error",
            headers: { "Content-Type": "application/json" },
          });
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

  return { getClient, getMount, addClient, removeClient };
}
