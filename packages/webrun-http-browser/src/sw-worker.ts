/// <reference lib="webworker" />

import { type SwHttpDispatcherOptions, startHttpDispatcher } from "./sw/http-sw-dispatcher.js";

declare const self: ServiceWorkerGlobalScope & {
  HTTP_DISPATCHER_OPTIONS?: Omit<SwHttpDispatcherOptions, "self">;
};

// OPTIONS FROM A GLOBAL, as `relay-sw.js` takes `RELAY_OPTIONS`: this bundle is
// loaded by `importScripts` from a host's own worker script, which runs first
// and can set them (a `route` function, timeouts). Absent, the defaults.
startHttpDispatcher({ log: console.log, ...self.HTTP_DISPATCHER_OPTIONS, self });
