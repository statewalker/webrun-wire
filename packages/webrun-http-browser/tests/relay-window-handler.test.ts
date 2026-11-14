/**
 * The relay iframe's side of the handshake (`getRelayWindowMessageHandler`)
 * and `newServiceWorkerPort`, against fakes of `window` and
 * `navigator.serviceWorker` (this suite runs in node), and the parent's side
 * (`newRemoteRelayChannel`) against a fake iframe. The real-browser
 * counterparts are in tests/browser/.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRelayWindowMessageHandler,
  newRemoteRelayChannel,
  newServiceWorkerPort,
} from "../src/relay/index.js";

/** A `navigator.serviceWorker` whose registration activates at once, or fails. */
function fakeServiceWorkerContainer(options: { fail?: boolean } = {}) {
  const container = new EventTarget() as EventTarget & Record<string, unknown>;
  const worker = Object.assign(new EventTarget(), {
    state: "activated",
    postMessage: vi.fn(),
  });
  const registration = Object.assign(new EventTarget(), {
    active: worker,
    installing: null,
    waiting: null,
    scope: "https://relay.example/",
  });
  container.controller = null;
  container.register = vi.fn(async () => {
    if (options.fail) throw new Error("worker failed to start");
    return registration;
  });
  return { container, worker, registration };
}

function connectEvent(source: unknown, ports: MessagePort[]): MessageEvent {
  const event = new MessageEvent("message", { data: { type: "CONNECT" } });
  Object.defineProperty(event, "ports", { value: ports });
  Object.defineProperty(event, "source", { value: source });
  return event;
}

/** Makes one channel call on `port` and resolves with the raw reply. */
function call(port: MessagePort, type: string): Promise<{ result?: unknown; error?: unknown }> {
  return new Promise((resolve) => {
    const reply = new MessageChannel();
    reply.port1.onmessage = (event) => resolve(event.data);
    port.postMessage({ type, params: {} }, [reply.port2]);
  });
}

const parentWindow = { name: "parent" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getRelayWindowMessageHandler", () => {
  it("ignores a CONNECT from a window other than its parent", async () => {
    const { container } = fakeServiceWorkerContainer();
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: container });
    const handler = getRelayWindowMessageHandler({ swUrl: "https://relay.example/sw.js" });

    const intruder = new MessageChannel();
    await handler(connectEvent({ name: "intruder" }, [intruder.port1]));
    expect(container.register).not.toHaveBeenCalled();

    // The parent's own CONNECT is still accepted afterwards.
    const parent = new MessageChannel();
    await handler(connectEvent(parentWindow, [parent.port1]));
    expect(container.register).toHaveBeenCalledTimes(1);
    intruder.port2.close();
    parent.port2.close();
  });

  it("acknowledges a CONNECT on the optional second port once the bridge is up", async () => {
    const { container } = fakeServiceWorkerContainer();
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: container });
    const handler = getRelayWindowMessageHandler({ swUrl: "https://relay.example/sw.js" });

    const main = new MessageChannel();
    const ack = new MessageChannel();
    const acked = new Promise((resolve) => {
      ack.port1.onmessage = (event) => resolve(event.data);
    });
    await handler(connectEvent(parentWindow, [main.port1, ack.port2]));
    expect(await acked).toEqual({ ok: true });
    main.port2.close();
    ack.port1.close();
  });

  it("a worker that fails to start: no unhandled rejection, the error is reported, a retry is accepted", async () => {
    const failing = fakeServiceWorkerContainer({ fail: true });
    vi.stubGlobal("window", { parent: parentWindow });
    vi.stubGlobal("navigator", { serviceWorker: failing.container });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = getRelayWindowMessageHandler({ swUrl: "https://relay.example/sw.js" });

    const first = new MessageChannel();
    const ack = new MessageChannel();
    const acked = new Promise<{ error?: { message?: string } }>((resolve) => {
      ack.port1.onmessage = (event) => resolve(event.data);
    });
    // Resolves: the failure is not rethrown out of the message handler.
    await expect(handler(connectEvent(parentWindow, [first.port1, ack.port2]))).resolves.toBe(
      undefined,
    );
    expect((await acked).error?.message).toMatch(/failed to start/);
    // Calls on the failed port are answered with the error, as before.
    const reply = await call(first.port2, "REGISTER");
    expect((reply.error as { message?: string }).message).toMatch(/failed to start/);

    // A later CONNECT is accepted and tries again.
    const second = new MessageChannel();
    await handler(connectEvent(parentWindow, [second.port1]));
    expect(failing.container.register).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalled();
    first.port2.close();
    second.port2.close();
    ack.port1.close();
  });
});

describe("newServiceWorkerPort", () => {
  it("stops listening to the worker once its signal aborts", async () => {
    const { container } = fakeServiceWorkerContainer();
    vi.stubGlobal("navigator", { serviceWorker: container });
    const removeSpy = vi.spyOn(container, "removeEventListener");
    const controller = new AbortController();
    const port = newServiceWorkerPort(undefined, { signal: controller.signal });
    controller.abort();
    expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function));
    port.close();
  });
});

/**
 * A fake `document` whose iframes "load" on the next tick, or fail to. The
 * frame's window hands every CONNECT to `onConnect`.
 */
function fakeDocument(
  onConnect: (targetOrigin: string, ports: MessagePort[]) => void,
  { fail = false }: { fail?: boolean } = {},
) {
  type FakeFrame = {
    style: Record<string, string>;
    src: string;
    onload?: () => void;
    onerror?: () => void;
    parentElement?: { removeChild(child: unknown): void };
    contentWindow: { postMessage(data: unknown, origin: string, ports: MessagePort[]): void };
  };
  const frames: FakeFrame[] = [];
  const body = {
    removeChild(child: FakeFrame) {
      child.parentElement = undefined;
    },
    appendChild(child: FakeFrame) {
      child.parentElement = body;
      setTimeout(() => (fail ? child.onerror?.() : child.onload?.()), 0);
    },
  };
  const document = {
    body,
    createElement(): FakeFrame {
      const frame: FakeFrame = {
        style: {},
        src: "",
        contentWindow: {
          postMessage: (_data, origin, ports) => onConnect(origin, ports),
        },
      };
      frames.push(frame);
      return frame;
    },
  };
  return { document, frames };
}

describe("newRemoteRelayChannel", () => {
  const url = new URL("https://relay.example/relay.html");

  it("posts the CONNECT to the relay's origin, not to any", async () => {
    const origins: string[] = [];
    const { document } = fakeDocument((origin) => origins.push(origin));
    vi.stubGlobal("document", document);
    const connection = await newRemoteRelayChannel({ url });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(origins).toEqual(["https://relay.example"]);
    connection.close();
  });

  it("a load failure without a timeout is not an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { document } = fakeDocument(() => {}, { fail: true });
      vi.stubGlobal("document", document);
      const connection = await newRemoteRelayChannel({ url });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
      connection.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("with a timeout: resolves once the relay acknowledges", async () => {
    const { document } = fakeDocument((_origin, ports) => {
      ports[1]?.postMessage({ ok: true });
    });
    vi.stubGlobal("document", document);
    const connection = await newRemoteRelayChannel({ url, timeout: 1000 });
    expect(connection.port).toBeDefined();
    connection.close();
  });

  it("with a timeout: rejects with the relay's error and removes the iframe", async () => {
    const { document, frames } = fakeDocument((_origin, ports) => {
      ports[1]?.postMessage({ error: { message: "worker failed to start" } });
    });
    vi.stubGlobal("document", document);
    await expect(newRemoteRelayChannel({ url, timeout: 1000 })).rejects.toThrow(
      /worker failed to start/,
    );
    expect(frames[0]?.parentElement).toBeUndefined();
  });

  it("with a timeout: rejects when the relay never answers (missing or blocked relay page)", async () => {
    const { document, frames } = fakeDocument(() => {});
    vi.stubGlobal("document", document);
    await expect(newRemoteRelayChannel({ url, timeout: 50 })).rejects.toThrow(/did not answer/);
    expect(frames[0]?.parentElement).toBeUndefined();
  });
});
