/**
 * The upstream the scenarios call, and the origin the browser half is served
 * from — deliberately the same origin, so the browser run is not measuring
 * CORS instead of the route table.
 */

import { createServer, type Server } from "node:http";

export interface Fixture {
  origin: string;
  server: Server;
  /** Serves this page HTML at `/page`; the browser run injects its bundle into it. */
  close(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><pre id=out>pending</pre></body></html>");
      return;
    }

    if (url.pathname.startsWith("/echo")) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: url.pathname, query: url.search, headers }));
      return;
    }

    if (url.pathname.startsWith("/redirects")) {
      res.writeHead(302, { location: `${url.origin}/echo/redirected` });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/stream")) {
      // One chunk immediately, one after a second: a proxy that buffers cannot
      // deliver the first before the second exists.
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.write("first-chunk\n");
      setTimeout(() => res.end("second-chunk\n"), 1000);
      return;
    }

    res.writeHead(404).end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");

  return {
    // `localhost`, not `127.0.0.1`: a secure context in the browser, and the
    // same origin the page is served from.
    origin: `http://localhost:${address.port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
