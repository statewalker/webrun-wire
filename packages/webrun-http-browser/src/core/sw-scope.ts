/**
 * A ServiceWorker's global scope, as this package's API takes it: structurally, so that code
 * importing the package's declarations compiles with the DOM lib alone. TypeScript's
 * `ServiceWorkerGlobalScope` is in the WebWorker lib, which a page's or a library's
 * compilation does not load. A ServiceWorker's `self` is one.
 */
export interface ServiceWorkerScope extends EventTarget {
  readonly location: { readonly href: string; readonly origin: string };
  readonly registration?: { readonly scope: string };
  readonly clients: unknown;
  skipWaiting(): Promise<void>;
}

/** A ServiceWorker's `fetch` event, structurally (see `ServiceWorkerScope`). */
export interface FetchEventLike extends Event {
  readonly request: Request;
  respondWith(response: Response | PromiseLike<Response>): void;
}
