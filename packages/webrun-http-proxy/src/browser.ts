/**
 * The browser profile: routes in `localStorage`.
 *
 * `localStorage` IS the reason `assertNoSecrets` exists. It survives a reload,
 * a shared machine and anyone who opens devtools, so a credential written here
 * is a credential leaked — which is exactly what building the proxy page on an
 * earlier shape of this API would have done.
 */

import { assertNoSecrets, type RouteStore, type StoredRoute } from "./store.js";

const DEFAULT_KEY = "webrun:proxy:routes";

export function localStorageRouteStore(key: string = DEFAULT_KEY): RouteStore {
  return {
    async load() {
      const raw = globalThis.localStorage?.getItem(key);
      // `null` from `getItem` means never written. Distinct from `"[]"`.
      if (raw == null) return undefined;
      try {
        return JSON.parse(raw) as StoredRoute[];
      } catch {
        // Corrupt is not "never written": resurrecting defaults over a table
        // somebody edited would be worse than starting empty and saying so.
        return [];
      }
    },
    async save(routes) {
      assertNoSecrets(routes);
      globalThis.localStorage?.setItem(key, JSON.stringify(routes));
    },
  };
}
