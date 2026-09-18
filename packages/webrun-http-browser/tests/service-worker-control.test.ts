/**
 * `awaitServiceWorkerControl` / `awaitActiveServiceWorker` against fakes of
 * the ServiceWorker container, registration and worker. The real-browser
 * counterpart, with hard reloads in Chromium and Firefox, is
 * tests/browser/sw-control.browser.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitActiveServiceWorker,
  awaitServiceWorkerControl,
  handleClaimRequests,
  ServiceWorkerControlError,
} from "../src/core/service-worker-control.js";

class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  readonly scriptURL = "http://localhost/sw.js";
  /** What the worker does with a CLAIM request: take control, only answer, or ignore it. */
  onClaim: "claim" | "answer-only" | "ignore" = "claim";
  constructor(
    state: ServiceWorkerState,
    private readonly container?: FakeContainer,
  ) {
    super();
    this.state = state;
  }
  setState(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
  postMessage(data: { type: string }, transfer: MessagePort[] = []): void {
    if (data.type !== "CLAIM" || this.onClaim === "ignore") return;
    if (this.onClaim === "claim" && this.container) this.container.takeControl(this);
    transfer[0]?.postMessage({ result: true });
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  takeControl(worker: FakeWorker): void {
    this.controller = worker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

class FakeRegistration extends EventTarget {
  readonly scope = "http://localhost/";
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
}

function setup({ controlled = false, state = "activated" as ServiceWorkerState } = {}) {
  const container = new FakeContainer();
  const registration = new FakeRegistration();
  const worker = new FakeWorker(state, container);
  if (state === "installing" || state === "installed") registration.installing = worker;
  else registration.active = worker;
  if (controlled) container.controller = worker;
  return {
    container,
    registration,
    worker,
    asRegistration: registration as unknown as ServiceWorkerRegistration,
    asContainer: container as unknown as ServiceWorkerContainer,
  };
}

function stubPageGlobals() {
  const store = new Map<string, string>();
  const reload = vi.fn();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("location", { reload });
  return { store, reload };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("awaitActiveServiceWorker", () => {
  it("resolves at once with an activated worker", async () => {
    const { asRegistration, worker } = setup();
    expect(await awaitActiveServiceWorker(asRegistration, { timeout: 50 })).toBe(worker);
  });

  it("follows an installing worker to activated", async () => {
    const { registration, asRegistration, worker } = setup({ state: "installing" });
    const active = awaitActiveServiceWorker(asRegistration, { timeout: 1000 });
    worker.setState("installed");
    registration.installing = null;
    registration.active = worker;
    worker.setState("activating");
    worker.setState("activated");
    expect(await active).toBe(worker);
  });

  it("rejects with activation-timeout when the worker never activates", async () => {
    const { asRegistration } = setup({ state: "installing" });
    const error = await awaitActiveServiceWorker(asRegistration, { timeout: 30 }).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceWorkerControlError);
    expect(error).toMatchObject({
      name: "ServiceWorkerControlError",
      reason: "activation-timeout",
    });
    expect(error.message).toMatch(/did not activate within 30 ms; it is "installing"/);
  });
});

describe("awaitServiceWorkerControl", () => {
  it("resolves at once when the page is already controlled", async () => {
    const { asRegistration, asContainer, worker } = setup({ controlled: true });
    const controller = await awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 50,
    });
    expect(controller).toBe(worker);
  });

  it("an uncontrolled page (hard reload): asks the worker to claim it, resolves on controllerchange", async () => {
    const { asRegistration, asContainer, worker } = setup();
    const post = vi.spyOn(worker, "postMessage");
    const controller = await awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 1000,
    });
    expect(controller).toBe(worker);
    expect(post).toHaveBeenCalledWith({ type: "CLAIM", params: {} }, expect.any(Array));
  });

  it("control arriving during activation (first visit) needs no claim", async () => {
    const { registration, asRegistration, container, asContainer, worker } = setup({
      state: "installing",
    });
    const post = vi.spyOn(worker, "postMessage");
    const controlled = awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 1000,
    });
    registration.installing = null;
    registration.active = worker;
    worker.setState("activating");
    container.takeControl(worker); // the worker's own clients.claim() on activate
    worker.setState("activated");
    expect(await controlled).toBe(worker);
    expect(post).not.toHaveBeenCalled();
  });

  it("a worker that never answers: rejects with uncontrolled after the timeout", async () => {
    const { asRegistration, asContainer, worker } = setup();
    worker.onClaim = "ignore";
    const started = Date.now();
    const error = await awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 60,
    }).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toMatchObject({ name: "ServiceWorkerControlError", reason: "uncontrolled" });
    expect(error.message).toMatch(/hard reload/);
    expect(error.message).toMatch(/reloadIfUncontrolled/);
    expect(error.message).toContain("http://localhost/sw.js");
  });

  it("a worker that answers but does not take control: rejects after a short grace, not the full timeout", async () => {
    const { asRegistration, asContainer, worker } = setup();
    worker.onClaim = "answer-only";
    const started = Date.now();
    const error = await awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 20_000,
    }).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error).toMatchObject({ reason: "uncontrolled" });
  });

  it("reloadIfUncontrolled: reloads once, and does not settle while the page unloads", async () => {
    const { reload, store } = stubPageGlobals();
    const { asRegistration, asContainer, worker } = setup();
    worker.onClaim = "ignore";
    let settled = false;
    void awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 30,
      reloadIfUncontrolled: true,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(store.size).toBe(1);
  });

  it("reloadIfUncontrolled: a page that is uncontrolled again after the reload rejects instead of looping", async () => {
    const { reload, store } = stubPageGlobals();
    const { asRegistration, asContainer, worker } = setup();
    worker.onClaim = "ignore";
    store.set(`webrun-http-browser:reloaded-uncontrolled:${asRegistration.scope}`, "1");
    const error = await awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 30,
      reloadIfUncontrolled: true,
    }).catch((e) => e);
    expect(reload).not.toHaveBeenCalled();
    expect(error).toMatchObject({ reason: "uncontrolled" });
    // The guard is cleared, so a later hard reload may use its one reload again.
    expect(store.size).toBe(0);
  });

  it("reloadIfUncontrolled without sessionStorage: rejects rather than risk a reload loop", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    vi.stubGlobal("sessionStorage", undefined);
    const { asRegistration, asContainer, worker } = setup();
    worker.onClaim = "ignore";
    const error = await awaitServiceWorkerControl(asRegistration, {
      container: asContainer,
      timeout: 30,
      reloadIfUncontrolled: true,
    }).catch((e) => e);
    expect(reload).not.toHaveBeenCalled();
    expect(error).toMatchObject({ reason: "uncontrolled" });
  });

  it("a successful start clears a pending reload guard", async () => {
    const { store } = stubPageGlobals();
    const { asRegistration, asContainer } = setup({ controlled: true });
    store.set(`webrun-http-browser:reloaded-uncontrolled:${asRegistration.scope}`, "1");
    await awaitServiceWorkerControl(asRegistration, { container: asContainer, timeout: 50 });
    expect(store.size).toBe(0);
  });
});

describe("handleClaimRequests (worker side)", () => {
  it("answers CLAIM with clients.claim(), keeping the worker alive until it resolves", async () => {
    const claim = vi.fn(async () => {});
    const self = Object.assign(new EventTarget(), { clients: { claim } });
    const stop = handleClaimRequests(self as unknown as ServiceWorkerGlobalScope);
    const { port1, port2 } = new MessageChannel();
    const answer = new Promise((resolve) => {
      port1.onmessage = (event) => resolve(event.data);
    });
    const waitUntil = vi.fn();
    const event = Object.assign(new MessageEvent("message", { data: { type: "CLAIM" } }), {
      waitUntil,
    });
    Object.defineProperty(event, "ports", { value: [port2] });
    self.dispatchEvent(event);
    expect(await answer).toEqual({ result: true });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    stop();
    port1.close();
  });
});
