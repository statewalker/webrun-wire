import { HttpError } from "@statewalker/webrun-http-streams";
import { get, set } from "idb-keyval";
import { callChannel, handleChannelCalls } from "../core/data-calls.js";
import { newRegistry } from "../core/registry.js";
import { sendHttpRequest } from "../http/http-send-recieve.js";
import { splitServiceUrl } from "./split-service-url.js";

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

  register(
    handleChannelCalls(self, "REGISTER", async (event, data) => {
      const source = event.source as Client | null;
      if (!source) return false;
      const { key } = data as { key: string };
      return await clientsRegistry.addClient(key, source);
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
  addClient(clientKey: string, client: Client): Promise<boolean>;
  removeClient(clientKey: string): Promise<boolean>;
  getClient(clientKey: string): Promise<Client | undefined>;
}

function newClientsRegistry({ self, key = "clientsIds" }: ClientsRegistryOptions): ClientsRegistry {
  let _index: Record<string, string> | undefined;

  async function loadClientsIndex(): Promise<Record<string, string>> {
    if (!_index) {
      const entries = ((await get<Array<[string, string]>>(key)) ?? []) as Array<[string, string]>;
      _index = Object.fromEntries(entries);
    }
    return _index;
  }

  async function storeClientsIndex(): Promise<Record<string, string>> {
    const index = await loadClientsIndex();
    await set(key, Object.entries(index));
    return index;
  }

  async function addClient(clientKey: string, client: Client): Promise<boolean> {
    const index = await loadClientsIndex();
    const clientId = client.id;
    if (index[clientKey] === clientId) return false;
    index[clientKey] = clientId;
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

  async function getClient(clientKey: string): Promise<Client | undefined> {
    const index = await loadClientsIndex();
    const clientId = index[clientKey];
    if (!clientId) return undefined;
    const client = await self.clients.get(clientId);
    if (!client) {
      delete index[clientKey];
      await storeClientsIndex();
    }
    return client ?? undefined;
  }

  return { getClient, addClient, removeClient };
}
