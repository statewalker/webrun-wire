import { readFileSync } from "node:fs";

/**
 * Externals for a published bundle, derived from the package's own manifest.
 *
 * The policy is: everything the package declares as a `dependency` or a
 * `peerDependency` stays external. npm installs those for the consumer, so
 * inlining them only produces a second copy — and a second copy of
 * `@statewalker/webrun-streams` means a second `TransportClosedError` class,
 * which quietly breaks `instanceof` across package boundaries.
 *
 * Deriving the list from the manifest rather than hand-listing it in each
 * config is deliberate: the hand-written lists had drifted (a deleted
 * `@statewalker/webrun-ports`, a `peerjs` that was never imported, a missing
 * `@multiformats/multiaddr`, and four packages that inlined their workspace
 * deps by omission).
 *
 * Call as `externalsFrom(import.meta.url)` from a `rolldown.config.js` sitting
 * at the package root.
 *
 * @param {string} configUrl `import.meta.url` of the calling config.
 * @returns {(string | RegExp)[]} exact names plus their subpath patterns.
 */
export function externalsFrom(configUrl) {
  const manifest = JSON.parse(readFileSync(new URL("package.json", configUrl), "utf8"));
  const names = [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
  ];
  const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...names, ...names.map((name) => new RegExp(`^${escapeName(name)}/`))];
}
