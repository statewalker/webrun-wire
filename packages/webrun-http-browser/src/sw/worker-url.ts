/**
 * Resolve a `serviceWorkerUrl` option the way a page would: relative to the
 * current document. Absolute urls pass through untouched. A url that cannot
 * be resolved is reported with the option name and the offending value,
 * because the raw `TypeError: Failed to construct 'URL': Invalid URL` says
 * neither.
 */
export function resolveWorkerUrl(serviceWorkerUrl: string): URL {
  const base = globalThis.location?.href;
  try {
    return new URL(serviceWorkerUrl, base);
  } catch (error) {
    throw new Error(
      `Invalid serviceWorkerUrl: ${JSON.stringify(serviceWorkerUrl)}` +
        (base ? ` (relative to ${base})` : " (no document to resolve it against)"),
      { cause: error },
    );
  }
}
