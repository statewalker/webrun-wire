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

      // No mount set: a request under B's would-be prefix is not the relay's
      // and is left to the network -- the same outcome as if B had never
      // called REGISTER at all.
      await expectNotTheRelays(self, "https://relay.example/prefix-b/x");
    } finally {
      stop();
    }
  });
});

describe("a static mount is the host's, not a registration's", () => {
  // THE DOCUMENTED STATIC FLOW: the host declares `{ key: "app", path: "/" }`
  // at build time and the page calls `initHttpService(h, { key: "app", port })`
  // with no path of its own. The first registration must not delete the host's
  // own mount -- which is what a blanket `remove(key)` on a path-less REGISTER
  // did, leaving the origin with nothing mounted at all.
  it("survives a path-less registration of the same key, and then routes to it", async () => {
    const { self, clients } = makeSelf();
    const farPort = clients.addLive("A");
    const stopClient = handleChannelCalls(farPort, "CONNECT", async (_event, _data, callPort) => {
      handleHttpRequests(
        callPort as unknown as MessagePort,
        async () => new Response("from the app"),
      );
      return true;
    });
    const stop = startRelayServiceWorker(self, { mounts: [{ key: "app", path: "/" }] });
    try {
      expect(await register(self, "A", "app")).toEqual({ result: true });
      const response = await dispatchFetch(self, "https://relay.example/index.html");
      expect(await response.text()).toBe("from the app");
    } finally {
      stop();
      stopClient();
    }
  });

  // A `match` entry has no `path` at all, so a path-ful REGISTER used to
  // replace it with a prefix and the predicate stopped being consulted.
  it("a static predicate mount survives a path-ful registration of the same key", async () => {
    const { self, clients } = makeSelf();
    clients.add("A");
    const stop = startRelayServiceWorker(self, {
      mounts: [{ key: "app", match: (url) => url.pathname.endsWith(".md") }],
    });
    try {
      expect(await register(self, "A", "app", "/elsewhere/")).toEqual({ result: true });
      // Still the predicate's: the registration did not overwrite it.
      await expectTheRelays(self, "https://relay.example/readme.md");
      // And the registration's own path never became a mount.
      await expectNotTheRelays(self, "https://relay.example/elsewhere/x");
    } finally {
      stop();
    }
  });

  // The same rule on a cold start: a path persisted for a host key under an
  // earlier configuration must not come back and outrank the host's table.
  it("a persisted registration does not override a host key on restore", async () => {
    idbStore.set("clientsIds", [["app", { clientId: "A", path: "/other/" }]]);
    const { self, clients } = makeSelf();
    clients.add("A");
    const stop = startRelayServiceWorker(self, { mounts: [{ key: "app", path: "/app/" }] });
    try {
      await expectTheRelays(self, "https://relay.example/app/x");
      await expectNotTheRelays(self, "https://relay.example/other/x");
    } finally {
      stop();
    }
  });

  it("a dynamic mount is still removed by a path-less registration", async () => {
    const { self, clients } = makeSelf();
    clients.add("A");
    const stop = startRelayServiceWorker(self);
    try {
      expect(await register(self, "A", "svc", "/dyn/")).toEqual({ result: true });
      await expectTheRelays(self, "https://relay.example/dyn/x");

      expect(await register(self, "A", "svc")).toEqual({ result: true });
      await expectNotTheRelays(self, "https://relay.example/dyn/x");
    } finally {
      stop();
    }
  });
});

describe("a request that is nobody's", () => {
  // THE RULE THE DESIGN RESTS ON: a request matching no mount is not the
  // relay's, and the worker must not call `respondWith` for it at all.
  // Answering it with `fetch(request)` instead looks equivalent and is not:
  // it defeats navigation preload, and a request with `cache: "only-if-cached"`
  // makes `fetch()` throw, turning a perfectly good cached response into a
  // network error. Every consumer with no mounts takes this path for every
  // subresource and every navigation.
  it("is left alone once the restore has settled", async () => {
    const { self } = makeSelf();
    const stop = startRelayServiceWorker(self);
    try {
      await settled();
      await expectNotTheRelays(self, "https://relay.example/index.html");
      await expectNotTheRelays(self, "https://relay.example/assets/app.css");
    } finally {
      stop();
    }
  });

  // A restore that REJECTS (blocked storage, quota, private mode) must not
  // wedge routing, and its rejection must be observed at creation: until a
  // fetch awaited it, nothing did, and it surfaced as an `unhandledrejection`
  // in the worker.
  it("is left alone after a FAILED restore, whose rejection is observed", async () => {
    idbGet.mockRejectedValueOnce(new Error("indexeddb blocked"));
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { self } = makeSelf();
    const stop = startRelayServiceWorker(self);
    try {
      await settled();
      await settled();
      expect(rejections).toEqual([]);
      await expectNotTheRelays(self, "https://relay.example/index.html");
    } finally {
      stop();
      logSpy.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // Before the restore settles the table cannot be consulted synchronously,
  // and `respondWith` cannot be called later -- so those requests, and only
  // those, still take the async path and are re-issued.
  it("is answered from the network while the restore is still pending", async () => {
    let release: (value: Array<[string, unknown]>) => void = () => {};
    const pending = new Promise<Array<[string, unknown]>>((resolve) => {
      release = resolve;
    });
    idbGet.mockImplementationOnce(() => pending);

    const { self } = makeSelf();
    const stop = startRelayServiceWorker(self);
    try {
      const networkResponse = new Response("from the network");
      const fetchSpy = vi.fn(async () => networkResponse);
      vi.stubGlobal("fetch", fetchSpy);

      // Dispatched before the restore can possibly have settled.
      const responded = tryDispatchFetch(self, "https://relay.example/index.html");
      expect(responded).toBeDefined();

      release([]);
      expect(await responded).toBe(networkResponse);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
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

      // A path outside the mount table (and not `/~key/`) is nobody's: the
      // worker does not answer it at all, so there is nothing to decorate.
      await expectNotTheRelays(self, "https://relay.example/other");
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

/**
 * A request the relay does not claim reaches the network: the listener leaves
 * it alone entirely -- no `respondWith` -- so the browser performs it itself.
 */
async function expectNotTheRelays(self: ServiceWorkerGlobalScope, url: string): Promise<void> {
  const fetchSpy = vi.fn(async () => new Response("from the network"));
  vi.stubGlobal("fetch", fetchSpy);
  try {
    expect(tryDispatchFetch(self, url)).toBeUndefined();
    // Not re-issued either: the browser performs the request itself, which is
    // what keeps navigation preload and `cache: "only-if-cached"` working.
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * A request the relay DOES claim is answered by the relay: with no live client
 * behind the key that is an error response, which is still the relay's answer
 * and not the network's.
 */
async function expectTheRelays(self: ServiceWorkerGlobalScope, url: string): Promise<void> {
  const fetchSpy = vi.fn(async () => new Response("from the network"));
  vi.stubGlobal("fetch", fetchSpy);
  try {
    const response = await dispatchFetch(self, url);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Dispatches a `fetch` event the way the browser would, and resolves with
 * whatever `respondWith` was given. */
function dispatchFetch(self: ServiceWorkerGlobalScope, url: string): Promise<Response> {
  const captured = tryDispatchFetch(self, url);
  if (!captured) throw new Error("fetch listener did not call respondWith");
  return captured;
}

/** Lets every pending microtask -- the registry restore among them -- run. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Dispatches a `fetch` event and returns what `respondWith` was given, or
 * `undefined` when the listener did not call it at all. */
function tryDispatchFetch(
  self: ServiceWorkerGlobalScope,
  url: string,
): Promise<Response> | undefined {
  const request = new Request(url);
  let captured: Promise<Response> | undefined;
  const fetchEvent = Object.assign(new Event("fetch"), {
    request,
    respondWith: (p: Promise<Response>) => {
      captured = p;
    },
  });
  (self as unknown as EventTarget).dispatchEvent(fetchEvent);
  return captured;
}
