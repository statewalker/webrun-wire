/**
 * Which configured upstream a mesh-side path belongs to.
 *
 * THE UPSTREAM IS NEVER TAKEN FROM THE REQUEST. `cors-anywhere` puts the
 * destination in the URL (`/https://example.com/`), which is why its public
 * instance is permanently abused. Here a caller selects among upstreams the
 * operator configured and can reach nothing else, so this module must never
 * gain a wildcard or passthrough mode.
 */

export interface ProxyRoute {
  /** Mesh-side prefix, leading slash, no trailing slash: `/openai`. */
  prefix: string;
  /** Upstream base: `https://api.openai.com/v1`. */
  upstream: string;
  /** Applied to every forwarded request, last, so operator config wins. */
  headers: Record<string, string>;
}

/**
 * The route owning `pathname`, and what follows its prefix.
 *
 * LONGEST PREFIX WINS, so `/openai/admin` can go somewhere other than
 * `/openai`, and the answer does not depend on the order routes were added --
 * an ordering dependency would make the UI's list order silently meaningful.
 */
export function matchRoute(
  routes: readonly ProxyRoute[],
  pathname: string,
): { route: ProxyRoute; rest: string } | null {
  let best: { route: ProxyRoute; rest: string } | null = null;
  for (const route of routes) {
    if (!pathname.startsWith(route.prefix)) continue;
    const rest = pathname.slice(route.prefix.length);
    // A prefix is a SEGMENT, not a string prefix: `/open` must not swallow
    // `/openai/models`, or adding a short route would silently capture longer
    // unrelated ones.
    if (rest !== "" && !rest.startsWith("/")) continue;
    if (best == null || route.prefix.length > best.route.prefix.length) best = { route, rest };
  }
  return best;
}

/** The absolute upstream URL for a matched route, carrying `search` unchanged. */
export function upstreamUrl(route: ProxyRoute, rest: string, search: string): string {
  const base = route.upstream.endsWith("/") ? route.upstream.slice(0, -1) : route.upstream;
  return `${base}${rest}${search}`;
}
