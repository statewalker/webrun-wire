/**
 * The relay ServiceWorker runtime, for a host that builds its own worker.
 *
 * TWO WAYS TO SHIP THE RELAY WORKER, and this is the typed one. A host that
 * takes the prebuilt bundle loads `@statewalker/webrun-http-browser/relay-sw`
 * through classic `importScripts` and passes its options in
 * `self.RELAY_OPTIONS`, which cannot be typed from the outside because that
 * bundle ships no declarations. A host that bundles its own worker imports
 * this module instead and calls `startRelayServiceWorker(self, { … })`
 * directly, with `RelayServiceWorkerOptions` to type the options — including
 * `self.RELAY_OPTIONS`, for a host writing the tiny loader script by hand.
 *
 * Kept as its own entry rather than re-exported from the package root: this
 * code only runs inside a ServiceWorker, and the root entry is what pages
 * import.
 */

export type { RelayServiceWorkerOptions } from "./relay/index-sw.js";
export { startRelayServiceWorker } from "./relay/index-sw.js";
export type { MountSpec } from "./relay/mount-table.js";
