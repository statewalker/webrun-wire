/// <reference lib="webworker" />

import { callChannel, handleChannelCalls } from "./data-calls.js";
import { withDeadline } from "./deadline.js";

/**
 * How long, by default, the page waits for its ServiceWorker to activate and
 * to take control before giving up. Generous: a first install downloads and
 * evaluates the worker script, which on a slow link takes seconds.
 */
export const DEFAULT_SERVICE_WORKER_TIMEOUT = 30_000;

/**
 * How long the page waits for `controllerchange` once the worker has
 * answered the `CLAIM` request. `clients.claim()` resolves only after the
 * browser has queued that event, so this is a grace period for delivery, not
 * a second budget.
 */
const CLAIM_GRACE_MS = 1_000;

/** Channel call a page sends to ask its ServiceWorker to `clients.claim()` it. */
export const CLAIM_CALL = "CLAIM";

/**
 * - `activation-timeout`: the worker did not activate in time.
 * - `uncontrolled`: the worker is active but the page is not controlled by it.
 * - `unresponsive`: the page is controlled, but the worker did not answer the
 *   adapter's handshake in time.
 */
export type ServiceWorkerControlFailure = "activation-timeout" | "uncontrolled" | "unresponsive";

/**
 * Why a page could not get a working ServiceWorker. `reason` says which wait
 * failed; check it (or `name`) rather than `instanceof`, because each of this
 * package's bundles carries its own copy of this class.
 */
export class ServiceWorkerControlError extends Error {
  readonly reason: ServiceWorkerControlFailure;
  constructor(reason: ServiceWorkerControlFailure, message: string) {
    super(message);
    this.name = "ServiceWorkerControlError";
    this.reason = reason;
  }
}

export interface AwaitServiceWorkerOptions {
  /** Upper bound for the whole wait, in ms. Default `DEFAULT_SERVICE_WORKER_TIMEOUT`. */
  timeout?: number;
}

export interface AwaitServiceWorkerControlOptions extends AwaitServiceWorkerOptions {
  /**
   * When the page is still uncontrolled after asking the worker to claim it,
   * reload the page once instead of rejecting. A normal reload is a
   * navigation, and navigations are controlled. Guarded by `sessionStorage`
   * so it never loops: if the reloaded page is uncontrolled too, it rejects.
   * Default `false`.
   */
  reloadIfUncontrolled?: boolean;
  /** For tests. Default `navigator.serviceWorker`. */
  container?: ServiceWorkerContainer;
}

/**
 * Resolves with the registration's worker once it is `activated`. Rejects
 * with a `ServiceWorkerControlError` (`reason: "activation-timeout"`) if that
 * takes longer than `timeout` — an install that throws or never finishes
 * would otherwise leave the caller waiting forever.
 */
export async function awaitActiveServiceWorker(
  registration: ServiceWorkerRegistration,
  { timeout = DEFAULT_SERVICE_WORKER_TIMEOUT }: AwaitServiceWorkerOptions = {},
): Promise<ServiceWorker> {
  const deadline = Date.now() + timeout;
  return await withDeadline(deadline, waitForActivated(registration), () => {
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    return new ServiceWorkerControlError(
      "activation-timeout",
      `ServiceWorker ${scriptUrl(worker)} (scope ${registration.scope}) did not activate within ` +
        `${timeout} ms` +
        (worker ? `; it is "${worker.state}"` : "") +
        ". Check the worker script for errors during install (DevTools → Application → " +
        "Service Workers), or raise the `timeout` option.",
    );
  });
}

/**
 * Resolves with the ServiceWorker that controls this page, once `registration`
 * has an activated worker and the page is controlled by it.
 *
 * A page can stay uncontrolled while its worker is active, and then no
 * `controllerchange` ever fires on its own:
 * - a hard reload (Ctrl+Shift+R) bypasses the worker for that load, and the
 *   worker's `clients.claim()` already ran when it activated;
 * - Firefox can leave a page loaded while the worker is running uncontrolled.
 *
 * So when the page is uncontrolled, this asks the active worker to claim it
 * again (a `CLAIM` channel call — this package's workers answer it) and waits
 * for `controllerchange`. Every wait is bounded by `timeout`. If control never
 * comes it reloads once (`reloadIfUncontrolled`) or rejects with a
 * `ServiceWorkerControlError` (`reason: "uncontrolled"`) that says what
 * happened and what to do.
 */
export async function awaitServiceWorkerControl(
  registration: ServiceWorkerRegistration,
  {
    timeout = DEFAULT_SERVICE_WORKER_TIMEOUT,
    reloadIfUncontrolled = false,
    container = navigator.serviceWorker,
  }: AwaitServiceWorkerControlOptions = {},
): Promise<ServiceWorker> {
  const deadline = Date.now() + timeout;
  // Listen before anything else, so a `controllerchange` that lands while we
  // wait for activation is not missed.
  const controlled = waitForController(container);
  try {
    const active = await awaitActiveServiceWorker(registration, { timeout });
    let controller = container.controller;
    if (!controller) {
      controller = await withDeadline(
        deadline,
        (async () => {
          // Answered only once `clients.claim()` has resolved; by then the
          // browser has queued `controllerchange` — or declined to.
          await Promise.race([callChannel(active, CLAIM_CALL, {}), controlled.promise]);
          return await Promise.race([controlled.promise, delay(CLAIM_GRACE_MS, null)]);
        })(),
        () => null,
      );
    }
    if (controller) {
      forgetReload(registration);
      return controller;
    }
    if (reloadIfUncontrolled && markReload(registration)) {
      location.reload();
      // The page is going away; settling now would only race the unload.
      return await new Promise<never>(() => {});
    }
    forgetReload(registration);
    throw new ServiceWorkerControlError(
      "uncontrolled",
      `This page is not controlled by its ServiceWorker ${scriptUrl(active)} ` +
        `(scope ${registration.scope}), although the worker is active, and the worker did not ` +
        `take control when asked (clients.claim()) within ${timeout} ms. ` +
        "This happens after a hard reload (Ctrl+Shift+R / Cmd+Shift+R), which bypasses " +
        "ServiceWorkers for that load, and in Firefox for some pages opened while the worker " +
        "was already running. Requests from this page would not reach the worker. " +
        "Reload the page normally, pass `reloadIfUncontrolled: true` to do that automatically, " +
        "check that the page is inside the worker's scope, and that the worker answers the " +
        `"${CLAIM_CALL}" request (this package's workers do).`,
    );
  } finally {
    controlled.cancel();
  }
}

/**
 * ServiceWorker side: answers the page's `CLAIM` request with
 * `clients.claim()`, which takes over every uncontrolled client in scope.
 * Returns a function that stops answering.
 */
export function handleClaimRequests(self: ServiceWorkerGlobalScope): () => void {
  return handleChannelCalls(self, CLAIM_CALL, (event) => {
    const claimed = self.clients.claim().then(() => true);
    (event as unknown as Partial<ExtendableMessageEvent>).waitUntil?.(claimed);
    return claimed;
  });
}

function waitForActivated(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
  return new Promise((resolve) => {
    const watched = new Set<ServiceWorker>();
    const check = () => {
      const active = registration.active;
      if (active?.state === "activated") {
        registration.removeEventListener("updatefound", watch);
        for (const worker of watched) worker.removeEventListener("statechange", check);
        resolve(active);
        return;
      }
      watch();
    };
    function watch() {
      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (!worker || watched.has(worker)) continue;
        watched.add(worker);
        worker.addEventListener("statechange", check);
      }
    }
    registration.addEventListener("updatefound", watch);
    check();
  });
}

function waitForController(container: ServiceWorkerContainer): {
  promise: Promise<ServiceWorker>;
  cancel: () => void;
} {
  let cancel = () => {};
  const promise = new Promise<ServiceWorker>((resolve) => {
    const onChange = () => {
      if (!container.controller) return;
      cancel();
      resolve(container.controller);
    };
    cancel = () => container.removeEventListener("controllerchange", onChange);
    container.addEventListener("controllerchange", onChange);
  });
  return { promise, cancel };
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function scriptUrl(worker: ServiceWorker | null | undefined): string {
  return worker?.scriptURL ? `"${worker.scriptURL}"` : "(no worker)";
}

function reloadKey(registration: ServiceWorkerRegistration): string {
  return `webrun-http-browser:reloaded-uncontrolled:${registration.scope}`;
}

/** Records the reload about to happen. `false` if one already happened, or if it cannot be recorded. */
function markReload(registration: ServiceWorkerRegistration): boolean {
  try {
    const key = reloadKey(registration);
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
    return true;
  } catch {
    // No storage, no loop guard: reloading could then repeat forever.
    return false;
  }
}

function forgetReload(registration: ServiceWorkerRegistration): void {
  try {
    sessionStorage.removeItem(reloadKey(registration));
  } catch {}
}
