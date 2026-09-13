/**
 * The scenarios, written ONCE and run on both platforms.
 *
 * This file is the isomorphism claim made falsifiable: Node imports it
 * directly, the browser gets it bundled into a page, and both report the same
 * list of `{name, pass, detail}`. A divergence shows up as a row that passes
 * in one column and fails in the other — not as two test files that drifted.
 *
 * Nothing here touches the mesh: the subject is the route table and the two
 * upstream kinds. Whether a mesh caller may reach them is policy, which rung
 * 01 already exercises end to end.
 */

import { routeTable, urlUpstream } from "../src/proxy.js";

export interface Outcome {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * @param origin An HTTP origin serving the fixture routes below. Supplied by
 *   the caller because a browser may only reach a real server, while Node
 *   could have used a handler directly — using the same real server on both
 *   keeps the comparison honest.
 */
export async function runScenarios(origin: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    out.push({ name, pass, detail });
  };

  /** A LOCAL SERVICE: an in-process handler, the "expose a local app" case. */
  const local = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization") ?? "none";
    return new Response(`local:${url.pathname}${url.search} auth=${auth}`, {
      headers: { "x-served-by": "local-handler" },
    });
  };

  const table = routeTable({
    mountPrefix: "/proxy",
    routes: () => [
      { prefix: "/local", describe: "in-process handler", upstream: local },
      {
        prefix: "/echo",
        describe: `${origin}/echo`,
        upstream: urlUpstream({
          base: `${origin}/echo`,
          headers: { "x-route-header": "from-route" },
          credential: () => ({ "x-upstream-credential": "secret-value" }),
          via: "1.1 webrun",
        }),
      },
      {
        prefix: "/redirects",
        describe: `${origin}/redirects`,
        upstream: urlUpstream({ base: `${origin}/redirects` }),
      },
      {
        prefix: "/stream",
        describe: `${origin}/stream`,
        upstream: urlUpstream({ base: `${origin}/stream` }),
      },
    ],
  });

  const call = (path: string, init?: RequestInit): Promise<Response> =>
    table(new Request(`http://mesh.local${path}`, init));

  // 1 — the local handler is reached, and the path is rewritten for it.
  {
    const res = await call("/proxy/local/deep/path?q=1");
    const text = await res.text();
    check(
      "local handler: reached and path rewritten",
      text.startsWith("local:/deep/path?q=1"),
      text,
    );
  }

  // 2 — a URL upstream is reached through the same table, same shape of call.
  {
    const res = await call("/proxy/echo/hello?x=2");
    const body = (await res.json()) as { path: string; query: string };
    check(
      "url upstream: reached through the same table",
      body.path === "/echo/hello" && body.query === "?x=2",
      JSON.stringify(body),
    );
  }

  // 3 — HYGIENE: the mesh credential is consumed, not forwarded.
  {
    const res = await call("/proxy/echo/x", { headers: { authorization: "Bearer MESH-TOKEN" } });
    const body = (await res.json()) as { headers: Record<string, string> };
    check(
      "url upstream: the mesh authorization is NOT forwarded",
      body.headers.authorization === undefined,
      JSON.stringify(body.headers),
    );
  }

  // 4 — the route's own credential IS injected, per destination.
  {
    const res = await call("/proxy/echo/x");
    const body = (await res.json()) as { headers: Record<string, string> };
    check(
      "url upstream: the route's credential and headers are injected",
      body.headers["x-upstream-credential"] === "secret-value" &&
        body.headers["x-route-header"] === "from-route",
      JSON.stringify(body.headers),
    );
  }

  // 4b — `Via`, SEPARATELY, because this is where the two platforms part.
  // ADR-0015 has an intermediary set `Via`. `Via` is a FORBIDDEN HEADER NAME
  // under the Fetch spec, so a browser drops it silently — no error, no
  // warning, the header simply does not arrive. A browser-hosted intermediary
  // therefore cannot announce itself, and the rung records that rather than
  // papering over it.
  {
    const res = await call("/proxy/echo/x");
    const body = (await res.json()) as { headers: Record<string, string> };
    check(
      "url upstream: Via is set (browsers forbid it)",
      body.headers.via === "1.1 webrun",
      `via=${body.headers.via ?? "dropped"}`,
    );
  }

  // 5 — a LOCAL upstream keeps the caller's authorization: identity must not
  // be stripped on the way to a handler inside the mesh.
  {
    const res = await call("/proxy/local/x", { headers: { authorization: "Bearer MESH-TOKEN" } });
    const text = await res.text();
    check(
      "local handler: the caller's authorization survives",
      text.includes("auth=Bearer MESH-TOKEN"),
      text,
    );
  }

  // 6 — hop-by-hop headers are not passed to a third party.
  {
    const res = await call("/proxy/echo/x", { headers: { te: "trailers" } });
    const body = (await res.json()) as { headers: Record<string, string> };
    check(
      "url upstream: hop-by-hop headers are removed",
      body.headers.te === undefined,
      JSON.stringify(body.headers),
    );
  }

  // 7 — THE REDIRECT DEFECT: a redirecting upstream must not be reported as
  // "unreachable". The shipping proxy returns 502 `upstream-unreachable`.
  {
    const res = await call("/proxy/redirects/go");
    const marker = res.headers.get("x-webrun-proxy");
    check(
      "url upstream: a redirect is reported as a redirect, not as unreachable",
      marker === "upstream-redirect" || (res.status >= 300 && res.status < 400),
      `status=${res.status} marker=${marker}`,
    );
  }

  // 8 — the listing names prefixes and never credentials.
  {
    const res = await call("/proxy");
    const text = await res.text();
    check(
      "listing: prefixes are listed and no credential leaks",
      text.includes("/local") && text.includes("/echo") && !text.includes("secret-value"),
      text,
    );
  }

  // 9 — an unmatched path is a marked 404, not a fall-through.
  {
    const res = await call("/proxy/nothing-here");
    check(
      "unmatched: 404 with the proxy's own marker",
      res.status === 404 && res.headers.get("x-webrun-proxy") === "no-route",
      `status=${res.status}`,
    );
  }

  // 10 — SEGMENT BOUNDARIES: `/local` must not swallow `/locales`.
  {
    const res = await call("/proxy/locales/fr");
    check(
      "matching: a shared prefix does not capture a different route",
      res.status === 404,
      `status=${res.status}`,
    );
  }

  // 11 — the body is streamed, not buffered: the first chunk arrives before
  // the upstream has finished producing the last.
  {
    const res = await call("/proxy/stream/slow");
    const reader = res.body?.getReader();
    const started = Date.now();
    const first = await reader?.read();
    const firstAt = Date.now() - started;
    await reader?.cancel();
    check(
      "url upstream: the body streams rather than buffering",
      first?.done === false && firstAt < 900,
      `first chunk after ${firstAt}ms`,
    );
  }

  return out;
}
