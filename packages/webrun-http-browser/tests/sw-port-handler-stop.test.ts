/**
 * `SwPortHandler.stop()` must unregister only the registration its own
 * `start()` made. Other registrations on the origin belong to other code — a
 * relay worker, an app's own worker — and stopping one adapter must not tear
 * them down.
 *
 * Runs the real `SwPortHandler` against fakes of `navigator.serviceWorker`,
 * its registrations and worker, as tests/service-worker-control.test.ts does.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SwPortHandler } from "../src/sw/sw-dispatcher.js";

/** An activated worker that answers every channel call with an empty result. */
class FakeWorker extends EventTarget {
  readonly state: ServiceWorkerState = "activated";
  readonly scriptURL = "http://localhost/sw-worker.js";
  postMessage(_data: unknown, transfer: MessagePort[] = []): void {
    transfer[0]?.postMessage({ result: {} });
  }
}

class FakeRegistration extends EventTarget {
  installing = null;
  waiting = null;
  active: FakeWorker | null;
  readonly unregister = vi.fn(async () => true);
  constructor(
    readonly scope: string,
    worker: FakeWorker | null = null,
  ) {
    super();
    this.active = worker;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SwPortHandler.stop()", () => {
  it("unregisters only its own registration", async () => {
    const worker = new FakeWorker();
    const own = new FakeRegistration("http://localhost/", worker);
    const other = new FakeRegistration("http://localhost/relay/");
    const container = Object.assign(new EventTarget(), {
      controller: worker,
      register: vi.fn(async () => own),
      getRegistrations: vi.fn(async () => [own, other]),
    });
    vi.stubGlobal("navigator", { serviceWorker: container });

    const handler = new SwPortHandler({
      key: "k",
      serviceWorkerUrl: "http://localhost/sw-worker.js",
      bindPort: () => {},
      timeout: 1000,
    });
    await handler.start();
    await handler.stop();

    expect(own.unregister).toHaveBeenCalledTimes(1);
    expect(other.unregister).not.toHaveBeenCalled();
  });
});
