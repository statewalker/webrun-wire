/// <reference lib="webworker" />

import { type RelayServiceWorkerOptions, startRelayServiceWorker } from "./relay/index-sw.js";

declare const self: ServiceWorkerGlobalScope & { RELAY_OPTIONS?: RelayServiceWorkerOptions };

// OPTIONS FROM A GLOBAL, because this bundle is loaded by `importScripts` from
// a host's own worker script, which runs first and can set them. A classic
// worker cannot pass arguments any other way, and module service workers are
// not reachable through the relay page's registration (the bundle is IIFE, and
// `getRelayWindowMessageHandler` registers with no `type`).
//
// Absent, the options are `{}` -- exactly what this file passed before, so a
// host that only `importScripts`es the bundle sees no change.
startRelayServiceWorker(self, self.RELAY_OPTIONS ?? {});
