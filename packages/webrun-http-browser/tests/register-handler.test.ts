/**
 * REGISTER end to end, against a fake `self` and a fake `idb-keyval` (this
 * suite's environment is "node": no real IndexedDB). Two things `mayRegister`
 * and the mount-table tests cannot see, because they never call
 * `startRelayServiceWorker` itself:
 *
 * 1. The default path (`last-wins`, no `canRegister`) must cost exactly what
 *    it cost before this task: no registry lookups beyond `addClient`'s own.
 *    `clientsRegistry.getClient` is the one call that can turn into a
 *    persisted write (it deletes a stale entry it finds), so `self.clients
 *    .get` -- the browser call only `getClient` makes -- is the cheapest
 *    correct oracle for "was the liveness check even run".
 * 2. A `first-wins` refusal must leave the registry AND the mount table
 *    exactly as they were: nothing persisted, and a request under the
 *    refused client's path must still miss the relay and reach the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChannelCalls } from "../src/core/data-calls.js";
import { handleHttpRequests } from "../src/http/http-send-recieve.js";
import { startRelayServiceWorker } from "../src/relay/index-sw.js";

const { idbStore, idbGet, idbSet } = vi.hoisted(() => {
  const idbStore = new Map<string, unknown>();
  return {
    idbStore,
    idbGet: vi.fn(async (key: string) => idbStore.get(key)),
    idbSet: vi.fn(async (key: string, value: unknown) => {
      idbStore.set(key, value);
    }),
  };
});

vi.mock("idb-keyval", () => ({ get: idbGet, set: idbSet }));

interface FakeClientRecord {
  id: string;
}

/** Stands in for `self.clients`: only `.get` is used by the code under test. */
class FakeClients {
  private readonly byId = new Map<string, FakeClientRecord>();
  readonly get = vi.fn(async (id: string) => this.byId.get(id));
  add(id: string): FakeClientRecord {
    const client = { id };
    this.byId.set(id, client);
    return client;
  }
  /**
   * A client backed by a real `MessagePort`, so the worker's own CONNECT call
   * (`callChannel(client, "CONNECT", ...)`) actually reaches something.
   * Returns the far end, for the test to answer on as the page side would.
   */
  addLive(id: string): MessagePort {
    const { port1, port2 } = new MessageChannel();
    const client = Object.assign(port1, { id }) as unknown as FakeClientRecord;
    this.byId.set(id, client);
    return port2;
  }
}

function makeSelf() {
  const clients = new FakeClients();
  const target = Object.assign(new EventTarget(), {
    clients,
    location: { origin: "https://relay.example" },
  });
  return { self: target as unknown as ServiceWorkerGlobalScope, clients };
}

/** Sends a REGISTER channel call the way the page-side client does, and
 * resolves with the raw `{ result }` or `{ error }` the handler posted back. */
function register(
  self: ServiceWorkerGlobalScope,
  sourceId: string,
  key: string,
  path?: string,
): Promise<{ result?: unknown; error?: { message?: string } }> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (event) => resolve(event.data);
    const messageEvent = Object.assign(
      new MessageEvent("message", { data: { type: "REGISTER", params: { key, path } } }),
      {},
    );
    Object.defineProperty(messageEvent, "ports", { value: [port2] });
    Object.defineProperty(messageEvent, "source", { value: { id: sourceId } });
    (self as unknown as EventTarget).dispatchEvent(messageEvent);
  });
}

afterEach(() => {
  idbStore.clear();
  idbGet.mockClear();
  idbSet.mockClear();
  vi.unstubAllGlobals();
});

describe("REGISTER: the default path pays no extra registry cost", () => {
  it("re-registering an already-registered key never calls self.clients.get", async () => {
    const { self, clients } = makeSelf();
    clients.add("A");
    const stop = startRelayServiceWorker(self);
    try {
      const first = await register(self, "A", "svc");
      expect(first).toEqual({ result: true });

      // Only the SECOND call is under test: the first one has no `current`
      // to look up yet, so it cannot exercise the liveness check either way.
      clients.get.mockClear();

      const second = await register(self, "A", "svc");
      expect(second).toEqual({ result: false }); // unchanged: a true no-op
      expect(clients.get).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

describe('REGISTER: takeover "first-wins"', () => {
  it("refuses a second live client with a throw, leaving the registry and the mount table untouched", async () => {
    const { self, clients } = makeSelf();
    clients.add("A");
    clients.add("B");
    const stop = startRelayServiceWorker(self, { takeover: "first-wins" });
    try {
      const first = await register(self, "A", "svc", "/prefix-a/");
      expect(first).toEqual({ result: true });

      idbSet.mockClear();
      const second = await register(self, "B", "svc", "/prefix-b/");
      expect(second.result).toBeUndefined();
      expect(second.error?.message).toMatch(/already served/);

      // No client recorded: nothing was persisted for the refusal, and the
      // stored index still shows only "A".
      expect(idbSet).not.toHaveBeenCalled();
      expect(idbStore.get("clientsIds")).toEqual([["svc", { clientId: "A", path: "/prefix-a/" }]]);

      // No mount set: a request under B's would-be prefix is not the
      // relay's, and reaches the network fetch was told to make -- the same
      // outcome as if B had never called REGISTER at all.
      const networkResponse = new Response("from the network");
      const fetchSpy = vi.fn(async () => networkResponse);
      vi.stubGlobal("fetch", fetchSpy);

      const request = new Request("https://relay.example/prefix-b/x");
      let captured: Promise<Response> | undefined;
      const fetchEvent = Object.assign(new Event("fetch"), {
        request,
        respondWith: (p: Promise<Response>) => {
          captured = p;
        },
      });
      (self as unknown as EventTarget).dispatchEvent(fetchEvent);

      expect(await captured).toBe(networkResponse);
      expect(fetchSpy).toHaveBeenCalledWith(request);
    } finally {
      stop();
    }
  });
});

describe("decorateResponse", () => {
  it("stamps the relay's own error response, but never a network fallthrough", async () => {
    const { self } = makeSelf();
    const decorateResponse = vi.fn((response: Response) => {
      const headers = new Headers(response.headers);
      headers.set("X-Decorated", "1");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
    // Mounted at "/app/" but no client ever registered: a request under it
    // takes the catch branch, which is exactly what this test targets.
    const stop = startRelayServiceWorker(self, {
      mounts: [{ key: "app", path: "/app/" }],
      decorateResponse,
    });
    try {
      const errorResponse = await dispatchFetch(self, "https://relay.example/app/x");
      expect(errorResponse.headers.get("X-Decorated")).toBe("1");
      expect(decorateResponse).toHaveBeenCalledTimes(1);

      // A path outside the mount table (and not `/~key/`) is nobody's, so it
      // falls through to the network, whose response must come back exactly
      // as `fetch` gave it -- undecorated.
      const networkResponse = new Response("from the network");
      const fetchSpy = vi.fn(async () => networkResponse);
      vi.stubGlobal("fetch", fetchSpy);

      const passThrough = await dispatchFetch(self, "https://relay.example/other");
      expect(passThrough).toBe(networkResponse);
      expect(passThrough.headers.get("X-Decorated")).toBeNull();
      expect(decorateResponse).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it("stamps a successful relayed response too", async () => {
    const { self, clients } = makeSelf();
    // A live client behind "app": answers CONNECT and then the HTTP request
    // itself, so `sendHttpRequest` in the SW's success branch actually
    // resolves with a response instead of throwing into the catch branch.
    const farPort = clients.addLive("A");
    const stopClient = handleChannelCalls(farPort, "CONNECT", async (_event, _data, callPort) => {
      handleHttpRequests(callPort as unknown as MessagePort, async () => new Response("hi"));
      return true;
    });

    const decorateResponse = vi.fn((response: Response) => {
      const headers = new Headers(response.headers);
      headers.set("X-Decorated", "1");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
    const stop = startRelayServiceWorker(self, { decorateResponse });
    try {
      const registered = await register(self, "A", "app", "/app/");
      expect(registered).toEqual({ result: true });

      const response = await dispatchFetch(self, "https://relay.example/app/x");
      expect(await response.text()).toBe("hi");
      expect(response.headers.get("X-Decorated")).toBe("1");
      expect(decorateResponse).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      stopClient();
    }
  });
});

/** Dispatches a `fetch` event the way the browser would, and resolves with
 * whatever `respondWith` was given. */
function dispatchFetch(self: ServiceWorkerGlobalScope, url: string): Promise<Response> {
  const request = new Request(url);
  let captured: Promise<Response> | undefined;
  const fetchEvent = Object.assign(new Event("fetch"), {
    request,
    respondWith: (p: Promise<Response>) => {
      captured = p;
    },
  });
  (self as unknown as EventTarget).dispatchEvent(fetchEvent);
  if (!captured) throw new Error("fetch listener did not call respondWith");
  return captured;
}
