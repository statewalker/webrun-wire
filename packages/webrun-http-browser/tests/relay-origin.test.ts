/**
 * #129: the relay tells embedders apart by origin.
 *
 * Every embedder reaches the relay worker through the same client, its own
 * relay iframe, so the worker cannot see who is on the other side. The iframe
 * can: the parent's CONNECT carries `ev.origin`, which the parent cannot
 * forge. These tests pin that the iframe
 *
 * - stamps that origin into every REGISTER / UNREGISTER / CONNECT it bridges,
 *   overriding whatever the parent put there;
 * - refuses an embedder its `allowedOrigins` / `canConnect` options reject;
 *
 * and that the worker passes the stamp to `canRegister` and to the new
 * `canConnect`, which can refuse a CONNECT before it reaches the service.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChannelCalls, withTransfer } from "../src/core/data-calls.js";
import { getRelayWindowMessageHandler } from "../src/relay/index.js";
import { onlyRegistrantOrigin, startRelayServiceWorker } from "../src/relay/index-sw.js";
import { WS_CONNECT_CALL } from "../src/sw/protocol.js";

const { idbStore } = vi.hoisted(() => ({ idbStore: new Map<string, unknown>() }));
vi.mock("idb-keyval", () => ({
  get: async (key: string) => idbStore.get(key),
  set: async (key: string, value: unknown) => {
    idbStore.set(key, value);
  },
}));

afterEach(() => {
  idbStore.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- the iframe

function fakeServiceWorkerContainer() {
  const container = new EventTarget() as EventTarget & Record<string, unknown>;
  const worker = Object.assign(new EventTarget(), { state: "activated", postMessage: vi.fn() });
  const registration = Object.assign(new EventTarget(), {
    active: worker,
    installing: null,
    waiting: null,
    scope: "https://relay.example/",
  });
  container.controller = null;
  container.register = vi.fn(async () => registration);
  return { container, worker };
}

const parentWindow = { name: "parent" };

function connectEvent(origin: string, ports: MessagePort[]): MessageEvent {
  const event = new MessageEvent("message", { data: { type: "CONNECT" }, origin });
  Object.defineProperty(event, "ports", { value: ports });
  Object.defineProperty(event, "source", { value: parentWindow });
  return event;
}

function nextAck(port: MessagePort): Promise<{ ok?: true; error?: { message?: string } }> {
  return new Promise((resolve) => {
    port.onmessage = (event) => resolve(event.data);
  });
}

/** Resolves once `fn` has been called `count` times. */
async function calledTimes(fn: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let i = 0; i < 100 && fn.mock.calls.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(fn).toHaveBeenCalledTimes(count);
}

describe("the relay iframe stamps the embedder's origin", () => {
  it("into REGISTER, UNREGISTER and CONNECT, over whatever the parent sent", async () => {
    const { container, worker } = fakeServiceWorkerContainer();
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: container });
    const handler = getRelayWindowMessageHandler({ swUrl: "https://relay.example/sw.js" });

    const main = new MessageChannel();
    const ack = new MessageChannel();
    const acked = nextAck(ack.port1);
    await handler(connectEvent("https://embedder.example", [main.port1, ack.port2]));
    expect(await acked).toEqual({ ok: true });

    const reply = new MessageChannel();
    main.port2.postMessage({ type: "REGISTER", params: { key: "FS" } }, [reply.port2]);
    main.port2.postMessage({
      type: "CONNECT",
      params: { key: "FS", origin: "https://forged.example" },
    });
    main.port2.postMessage({ type: "UNREGISTER", params: { key: "FS" } });
    main.port2.postMessage({ type: "OTHER", params: { key: "FS" } });
    await calledTimes(worker.postMessage, 4);

    const sent = worker.postMessage.mock.calls.map(([data]) => data);
    expect(sent[0]).toEqual({
      type: "REGISTER",
      params: { key: "FS", origin: "https://embedder.example" },
    });
    expect(sent[1]).toEqual({
      type: "CONNECT",
      params: { key: "FS", origin: "https://embedder.example" },
    });
    expect(sent[2]).toEqual({
      type: "UNREGISTER",
      params: { key: "FS", origin: "https://embedder.example" },
    });
    // Other calls pass through untouched.
    expect(sent[3]).toEqual({ type: "OTHER", params: { key: "FS" } });
    // The transferred reply port still travels with the message.
    expect(worker.postMessage.mock.calls[0]?.[1]).toHaveLength(1);
    main.port2.close();
    ack.port1.close();
  });

  it("refuses an embedder outside allowedOrigins, and answers its calls with the error", async () => {
    const { container } = fakeServiceWorkerContainer();
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: container });
    const handler = getRelayWindowMessageHandler({
      swUrl: "https://relay.example/sw.js",
      allowedOrigins: ["https://trusted.example"],
    });

    const main = new MessageChannel();
    const ack = new MessageChannel();
    const acked = nextAck(ack.port1);
    await handler(connectEvent("https://evil.example", [main.port1, ack.port2]));
    expect((await acked).error?.message).toMatch(/https:\/\/evil\.example/);
    expect(container.register).not.toHaveBeenCalled();

    const reply = new MessageChannel();
    const answered = nextAck(reply.port1);
    main.port2.postMessage({ type: "REGISTER", params: { key: "FS" } }, [reply.port2]);
    expect((await answered).error?.message).toMatch(/may not use this relay/);
    main.port2.close();
    ack.port1.close();
    reply.port1.close();
  });

  it("accepts an embedder in allowedOrigins", async () => {
    const { container } = fakeServiceWorkerContainer();
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: container });
    const handler = getRelayWindowMessageHandler({
      swUrl: "https://relay.example/sw.js",
      allowedOrigins: ["https://trusted.example"],
    });
    const main = new MessageChannel();
    const ack = new MessageChannel();
    const acked = nextAck(ack.port1);
    await handler(connectEvent("https://trusted.example", [main.port1, ack.port2]));
    expect(await acked).toEqual({ ok: true });
    main.port2.close();
    ack.port1.close();
  });

  it("asks canConnect with the embedder's origin", async () => {
    const { container } = fakeServiceWorkerContainer();
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: container });
    const canConnect = vi.fn(async (origin: string) => origin.endsWith(".trusted.example"));
    const handler = getRelayWindowMessageHandler({
      swUrl: "https://relay.example/sw.js",
      canConnect,
    });

    const refused = new MessageChannel();
    const refusedAck = new MessageChannel();
    const refusal = nextAck(refusedAck.port1);
    await handler(connectEvent("https://evil.example", [refused.port1, refusedAck.port2]));
    expect((await refusal).error).toBeDefined();
    expect(canConnect).toHaveBeenLastCalledWith("https://evil.example");

    // A refusal does not hold the slot: the next CONNECT is judged afresh.
    const main = new MessageChannel();
    const ack = new MessageChannel();
    const acked = nextAck(ack.port1);
    await handler(connectEvent("https://a.trusted.example", [main.port1, ack.port2]));
    expect(await acked).toEqual({ ok: true });
    expect(container.register).toHaveBeenCalledTimes(1);
    for (const port of [refused.port2, refusedAck.port1, main.port2, ack.port1]) port.close();
  });
});

// ---------------------------------------------------------------- the worker

interface FakeClient {
  id: string;
  url: string;
}

function makeSelf() {
  const byId = new Map<string, FakeClient>();
  const clients = {
    get: async (id: string) => byId.get(id),
    add(id: string): FakeClient {
      const client = { id, url: "https://relay.example/relay.html" };
      byId.set(id, client);
      return client;
    },
    /** A client whose CONNECTs land on the returned port. */
    addLive(id: string): MessagePort {
      const { port1, port2 } = new MessageChannel();
      byId.set(id, Object.assign(port1, { id, url: "https://relay.example/relay.html" }));
      return port2;
    },
  };
  const self = Object.assign(new EventTarget(), {
    clients,
    location: { origin: "https://relay.example", href: "https://relay.example/sw.js" },
  });
  return { self: self as unknown as ServiceWorkerGlobalScope, clients };
}

function call(
  self: ServiceWorkerGlobalScope,
  sourceId: string,
  type: string,
  params: Record<string, unknown>,
  ...transfer: MessagePort[]
): Promise<{ result?: unknown; error?: { message?: string } }> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (event) => resolve(event.data);
    const event = new MessageEvent("message", { data: { type, params } });
    Object.defineProperty(event, "ports", { value: [port2, ...transfer] });
    Object.defineProperty(event, "source", {
      value: { id: sourceId, url: "https://relay.example/relay.html" },
    });
    (self as unknown as EventTarget).dispatchEvent(event);
  });
}

describe("the relay worker vets embedders by the stamped origin", () => {
  it("passes the origin to canRegister, for REGISTER and UNREGISTER", async () => {
    const { self, clients } = makeSelf();
    clients.add("A");
    const canRegister = vi.fn(
      (_client: unknown, _key: string, _path?: string, origin?: string) =>
        origin === "https://owner.example",
    );
    const stop = startRelayServiceWorker(self, { canRegister });
    try {
      const refused = await call(self, "A", "REGISTER", {
        key: "FS",
        origin: "https://evil.example",
      });
      expect(refused.error?.message).toMatch(/may not register/);
      expect(canRegister).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "A" }),
        "FS",
        undefined,
        "https://evil.example",
      );

      expect(
        await call(self, "A", "REGISTER", { key: "FS", origin: "https://owner.example" }),
      ).toEqual({ result: true });

      const unregister = await call(self, "A", "UNREGISTER", {
        key: "FS",
        origin: "https://evil.example",
      });
      expect(unregister.error?.message).toMatch(/may not unregister/);
      expect(canRegister).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "A" }),
        "FS",
        undefined,
        "https://evil.example",
      );
    } finally {
      stop();
    }
  });

  it("refuses a CONNECT canConnect rejects, before it reaches the service", async () => {
    const { self, clients } = makeSelf();
    const farPort = clients.addLive("A");
    const served = vi.fn(async () => true);
    const stopService = handleChannelCalls(farPort, "CONNECT", served);
    const canConnect = vi.fn(onlyRegistrantOrigin);
    const stop = startRelayServiceWorker(self, { canConnect });
    try {
      expect(
        await call(self, "A", "REGISTER", { key: "FS", origin: "https://owner.example" }),
      ).toEqual({ result: true });

      const intruder = new MessageChannel();
      const refused = await call(
        self,
        "A",
        "CONNECT",
        { key: "FS", type: "http", origin: "https://evil.example" },
        intruder.port2,
      );
      expect(refused.error?.message).toMatch(/may not connect to "FS"/);
      expect(served).not.toHaveBeenCalled();
      expect(canConnect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          key: "FS",
          origin: "https://evil.example",
          registeredOrigin: "https://owner.example",
        }),
      );

      const owner = new MessageChannel();
      const accepted = await call(
        self,
        "A",
        "CONNECT",
        { key: "FS", type: "http", origin: "https://owner.example" },
        owner.port2,
      );
      expect(accepted).toEqual({ result: true });
      expect(served).toHaveBeenCalledTimes(1);
      intruder.port1.close();
      owner.port1.close();
    } finally {
      stop();
      stopService();
    }
  });

  it("without canConnect, every CONNECT reaches the service, as before", async () => {
    const { self, clients } = makeSelf();
    const farPort = clients.addLive("A");
    const stopService = handleChannelCalls(farPort, "CONNECT", async () => true);
    const stop = startRelayServiceWorker(self);
    try {
      await call(self, "A", "REGISTER", { key: "FS", origin: "https://owner.example" });
      const channel = new MessageChannel();
      expect(
        await call(
          self,
          "A",
          "CONNECT",
          { key: "FS", type: "http", origin: "https://other.example" },
          channel.port2,
        ),
      ).toEqual({ result: true });
      channel.port1.close();
    } finally {
      stop();
      stopService();
    }
  });

  it("keeps the registrant's origin across a worker restart", async () => {
    const first = makeSelf();
    first.clients.add("A");
    const stopFirst = startRelayServiceWorker(first.self);
    await call(first.self, "A", "REGISTER", { key: "FS", origin: "https://owner.example" });
    stopFirst();

    const second = makeSelf();
    const farPort = second.clients.addLive("A");
    const stopService = handleChannelCalls(farPort, "CONNECT", async () => true);
    const stop = startRelayServiceWorker(second.self, { canConnect: onlyRegistrantOrigin });
    try {
      const channel = new MessageChannel();
      const refused = await call(
        second.self,
        "A",
        "CONNECT",
        { key: "FS", type: "http", origin: "https://evil.example" },
        channel.port2,
      );
      expect(refused.error?.message).toMatch(/may not connect/);
      channel.port1.close();
    } finally {
      stop();
      stopService();
    }
  });
});

describe("a socket asked for through the relay iframe (review of #177)", () => {
  /** A live service that answers a socket CONNECT with a fresh port. */
  function socketService(farPort: MessagePort) {
    const served = vi.fn();
    const stop = handleChannelCalls(farPort, "CONNECT", async () => {
      served();
      const { port1 } = new MessageChannel();
      return withTransfer({ port: port1, protocol: "" }, [port1]);
    });
    return { served, stop };
  }

  it("is vetted by canConnect like a CONNECT, when it carries an embedder's stamp", async () => {
    const { self, clients } = makeSelf();
    const { served, stop: stopService } = socketService(clients.addLive("A"));
    const stop = startRelayServiceWorker(self, { canConnect: onlyRegistrantOrigin });
    try {
      await call(self, "A", "REGISTER", { key: "K", origin: "https://owner.example" });
      const refused = await call(self, "A", WS_CONNECT_CALL, {
        url: "https://relay.example/~K/socket",
        origin: "https://evil.example",
      });
      expect(refused.error?.message).toMatch(/may not connect to "K"/);
      expect(served).not.toHaveBeenCalled();

      const accepted = await call(self, "A", WS_CONNECT_CALL, {
        url: "https://relay.example/~K/socket",
        origin: "https://owner.example",
      });
      expect(accepted.error).toBeUndefined();
      expect(served).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      stopService();
    }
  });

  it("from a page of the relay origin itself (no stamp) still opens, as before", async () => {
    const { self, clients } = makeSelf();
    const { served, stop: stopService } = socketService(clients.addLive("A"));
    const stop = startRelayServiceWorker(self, { canConnect: onlyRegistrantOrigin });
    try {
      await call(self, "A", "REGISTER", { key: "K", origin: "https://owner.example" });
      const accepted = await call(self, "A", WS_CONNECT_CALL, {
        url: "https://relay.example/~K/socket",
      });
      expect(accepted.error).toBeUndefined();
      expect(served).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      stopService();
    }
  });

  it("the relay iframe stamps it too", async () => {
    const { container, worker } = fakeServiceWorkerContainer();
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: container });
    const handler = getRelayWindowMessageHandler({ swUrl: "https://relay.example/sw.js" });
    const main = new MessageChannel();
    await handler(connectEvent("https://embedder.example", [main.port1]));
    await calledTimes(container.register as ReturnType<typeof vi.fn>, 1);
    await new Promise((r) => setTimeout(r, 5));
    main.port2.postMessage({ type: WS_CONNECT_CALL, params: { url: "x" } });
    await calledTimes(worker.postMessage, 1);
    expect(worker.postMessage.mock.calls[0]?.[0]).toEqual({
      type: WS_CONNECT_CALL,
      params: { url: "x", origin: "https://embedder.example" },
    });
    main.port2.close();
  });
});

describe("onlyRegistrantOrigin", () => {
  it("allows only a caller whose embedder is the registrant's", () => {
    const client = { id: "A", url: "https://relay.example/relay.html" };
    expect(
      onlyRegistrantOrigin({
        key: "k",
        client,
        origin: "https://a",
        registeredOrigin: "https://a",
      }),
    ).toBe(true);
    expect(
      onlyRegistrantOrigin({
        key: "k",
        client,
        origin: "https://b",
        registeredOrigin: "https://a",
      }),
    ).toBe(false);
    // An unknown origin on either side never matches.
    expect(onlyRegistrantOrigin({ key: "k", client })).toBe(false);
    expect(onlyRegistrantOrigin({ key: "k", client, registeredOrigin: "https://a" })).toBe(false);
  });
});
