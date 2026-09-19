/**
 * Re-issuing a request to an outside origin, safely. That is the whole
 * package.
 *
 * It used to ship a route table too — prefix matching, a listing, a marker on
 * unmatched paths. All of that is what a ROUTER does, and every caller already
 * has one: the twelve scenarios that established this proxy's behaviour now
 * run against a plain Hono router and pass unchanged, which is the evidence
 * that removing it lost nothing.
 *
 * What is genuinely this package's own is `urlUpstream`, and it is not
 * obvious:
 *
 *   - `stripRequestHeaders` names the caller's own credential and whatever
 *     else its system treats as identity; those are CONSUMED by this hop, the
 *     way `Proxy-Authorization` is consumed by the proxy it names, because a
 *     third-party origin has no business seeing them. `authorization` is not
 *     special: it belongs to the application calling the upstream and is
 *     forwarded unless named;
 *   - hop-by-hop headers (RFC 9110 §7.6.1) are dropped;
 *   - the credential is read at REQUEST time, so it can be typed while traffic
 *     flows;
 *   - the body streams rather than buffering, and the caller's `signal` is
 *     forwarded so an abandoned request abandons the upstream call;
 *   - an opaque redirect (status 0) is reported as a redirect rather than as
 *     `502 upstream-unreachable`, which is what constructing a `Response` with
 *     status 0 throwing inside a `try` used to produce.
 *
 * Persisting route configuration went with the router, for the same reason:
 * the shape of that configuration belongs to whoever defines the routes.
 */

export {
  type FetchHandler,
  MARKER,
  type Upstream,
  type UrlUpstreamInit,
  urlUpstream,
} from "./proxy.js";
