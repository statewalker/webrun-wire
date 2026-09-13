/**
 * A reverse proxy as a fetch handler.
 *
 * "Reverse proxy" and "expose a local app" are ONE MECHANISM, and twelve
 * scenarios establish it: only the last step differs — a local handler is
 * *called*, a URL upstream is *re-issued*. Matching, rewriting, the listing,
 * the marker header and streaming are shared.
 *
 * EXTRACTED FROM `@statewalker/httpeers-expose`, where it was a mesh concept
 * by accident of where it was written. Nothing in it is about peers: it moves
 * a `Request` to an upstream and a `Response` back. The one place the old
 * package knew about meshes is now `stripRequestHeaders`, which any caller
 * uses for whatever its own system treats as proven identity.
 */

export {
  type FetchHandler,
  MARKER,
  type Route,
  routeTable,
  type RouteTableInit,
  type Upstream,
  urlUpstream,
  type UrlUpstreamInit,
} from "./proxy.js";
export { matchRoute, type ProxyRoute, upstreamUrl } from "./routes.js";
export {
  assertNoSecrets,
  rehydrate,
  type RehydrateInit,
  type RouteStore,
  SecretNotPersistableError,
  type StoredRoute,
  toStoredRoute,
} from "./store.js";
