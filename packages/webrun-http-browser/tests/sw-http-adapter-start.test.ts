/**
 * `SwHttpAdapter.start()` against a fake ServiceWorker container whose worker
 * is active and already controls the page, but never answers the
 * UPDATE_COMMUNICATION_PORT handshake. The real-browser counterpart is
 * "a controlling worker that never answers the handshake" in
 * tests/browser/sw-control.browser.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SwHttpAdapter } from "../src/sw/sw-http-adapter.js";

/** Active, controlling, and silent: it ignores every message. */
class SilentWorker extends EventTarget {
  readonly state: ServiceWorkerState = "activated";
  readonly scriptURL = "https://app.example/silent-sw.js";
  postMessage(): void {}
}

function stubControlledPage(): void {
  const worker = new SilentWorker();
  const registration = Object.assign(new EventTarget(), {
    scope: "https://app.example/",
    installing: null,
    waiting: null,
    active: worker,
    unregister: async () => true,
  });
  const container = Object.assign(new EventTarget(), {
    controller: worker,
    register: async () => registration,
  });
  // No `locks`: `holdLock` resolves at once, as it does where Web Locks are missing.
  vi.stubGlobal("navigator", { serviceWorker: container });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SwHttpAdapter.start()", () => {
  it("a page controlled from the start by a worker that never answers: rejects as unresponsive", async () => {
    // Fake timers freeze `Date.now()`: control and the handshake start in the
    // same millisecond, so `start()`'s deadline and the attach call's own
    // timeout are due together. Before the fix the call's timer, armed first,
    // won, and `start()` rejected with a plain
    // `Error: No answer to UPDATE_COMMUNICATION_PORT within 1000 ms`, the
    // Firefox flake of the browser test.
    vi.useFakeTimers();
    stubControlledPage();
    const adapter = new SwHttpAdapter({
      key: "t",
      serviceWorkerUrl: "https://app.example/silent-sw.js",
      timeout: 1000,
    });
    const started = adapter.start().then(
      () => ({ ok: true }) as const,
      (error: { name?: string; reason?: string; message?: string }) => error,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const error = await started;
    expect(error).toMatchObject({ name: "ServiceWorkerControlError", reason: "unresponsive" });
    expect((error as { message: string }).message).toMatch(
      /UPDATE_COMMUNICATION_PORT handshake within 1000 ms/,
    );
  });
});
