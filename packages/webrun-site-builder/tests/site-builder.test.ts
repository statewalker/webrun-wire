import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newBasicAuth } from "../src/basic-auth.js";
import { SiteBuilder } from "../src/site-builder.js";

async function withFiles(entries: Record<string, string>): Promise<MemFilesApi> {
  const api = new MemFilesApi();
  for (const [path, content] of Object.entries(entries)) {
    await api.write(path, [new TextEncoder().encode(content)]);
  }
  return api;
}

describe("SiteBuilder", () => {
  it("returns 404 when nothing is registered", async () => {
    const handler = new SiteBuilder().build();
    expect((await handler(new Request("http://x/"))).status).toBe(404);
  });

  it("serves static files from a single FilesApi root", async () => {
    const files = await withFiles({ "/index.html": "<p>home</p>" });
    const handler = new SiteBuilder().setFiles("/", files).build();
    expect(await (await handler(new Request("http://x/index.html"))).text()).toBe("<p>home</p>");
  });

  it("serves from multiple FilesApi prefixes without collision", async () => {
    const client = await withFiles({ "/index.html": "client-home" });
    const server = await withFiles({ "/api/entry.js": "export default 1;" });
    const handler = new SiteBuilder()
      .setFiles("/client", client)
      .setFiles("/server", server)
      .build();
    expect(await (await handler(new Request("http://x/client/index.html"))).text()).toBe(
      "client-home",
    );
    expect(await (await handler(new Request("http://x/server/api/entry.js"))).text()).toBe(
      "export default 1;",
    );
  });

  it("routes dynamic endpoints with params; non-matching paths fall through to files", async () => {
    const files = await withFiles({ "/about.html": "static-about" });
    const handler = new SiteBuilder()
      .setFiles("/", files)
      .setEndpoint("/todo/:id", "GET", async (_req, env) => Response.json({ id: env.params.id }))
      .build();

    // Endpoint matches a parametric path and beats anything files could serve.
    const apiResponse = await handler(new Request("http://x/todo/42"));
    expect(await apiResponse.json()).toEqual({ id: "42" });

    // A path the endpoint doesn't match falls through to files.
    const fileResponse = await handler(new Request("http://x/about.html"));
    expect(await fileResponse.text()).toBe("static-about");
  });

  it("defaults endpoint method to '*' when omitted", async () => {
    const handler = new SiteBuilder()
      .setEndpoint("/api/echo", async (request) => new Response(request.method))
      .build();
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await handler(new Request("http://x/api/echo", { method }));
      expect(await response.text()).toBe(method);
    }
  });

  it("honours a specific method when configured", async () => {
    const handler = new SiteBuilder()
      .setEndpoint("/api/data", "POST", async () => new Response("written"))
      .build();
    expect((await handler(new Request("http://x/api/data"))).status).toBe(404);
    const response = await handler(new Request("http://x/api/data", { method: "POST" }));
    expect(await response.text()).toBe("written");
  });

  it("runs auth predicates before routing and short-circuits on rejection", async () => {
    const files = await withFiles({ "/admin/panel.html": "secret" });
    const handler = new SiteBuilder()
      .setAuth("/admin/*", newBasicAuth({ tom: "!jerry!" }))
      .setFiles("/", files)
      .build();

    const anonymous = await handler(new Request("http://x/admin/panel.html"));
    expect(anonymous.status).toBe(401);

    const authed = await handler(
      new Request("http://x/admin/panel.html", {
        headers: { Authorization: `Basic ${btoa("tom:!jerry!")}` },
      }),
    );
    expect(await authed.text()).toBe("secret");
  });

  it("lets unmatched paths through the auth layer untouched", async () => {
    const files = await withFiles({ "/public.html": "hello" });
    const handler = new SiteBuilder()
      .setAuth("/admin/*", newBasicAuth({ tom: "!jerry!" }))
      .setFiles("/", files)
      .build();
    const response = await handler(new Request("http://x/public.html"));
    expect(await response.text()).toBe("hello");
  });

  it("calls the error handler when an endpoint throws", async () => {
    const errors: unknown[] = [];
    const handler = new SiteBuilder()
      .setEndpoint("/boom", async () => {
        throw new Error("nope");
      })
      .setErrorHandler((error) => {
        errors.push(error);
        return new Response("caught", { status: 500 });
      })
      .build();
    const response = await handler(new Request("http://x/boom"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("caught");
    expect((errors[0] as Error).message).toBe("nope");
  });

  it("falls back to a 500 default when no error handler is set", async () => {
    const handler = new SiteBuilder()
      .setEndpoint("/boom", async () => {
        throw new Error("nope");
      })
      .build();
    const response = await handler(new Request("http://x/boom"));
    expect(response.status).toBe(500);
  });

  it("supports dynamic import-style endpoints that vary per request", async () => {
    // Exercises the shape used in the webrun-http-browser demo: an endpoint
    // that asynchronously resolves a handler function per-call.
    const handler = new SiteBuilder()
      .setEndpoint("/api/*", async (request, env) => {
        const subHandler = async (_req: Request) => Response.json({ tail: env.params["0"] ?? "" });
        return subHandler(request);
      })
      .build();
    const response = await handler(new Request("http://x/api/users/1"));
    expect(await response.json()).toEqual({ tail: "users/1" });
  });

  it("setEnv values are merged into env alongside params on every call", async () => {
    const handler = new SiteBuilder()
      .setEnv({ db: "main", region: "eu" })
      .setEnv({ region: "us" }) // later call wins for shared keys
      .setEndpoint("/items/:id", async (_req, env) =>
        Response.json({ id: env.params.id, db: env.db, region: env.region }),
      )
      .build();
    const response = await handler(new Request("http://x/items/42"));
    expect(await response.json()).toEqual({ id: "42", db: "main", region: "us" });
  });

  it("env snapshot is taken at build() time; later setEnv calls do not leak in", async () => {
    const builder = new SiteBuilder()
      .setEnv({ flag: "before-build" })
      .setEndpoint("/probe", async (_req, env) => Response.json({ flag: env.flag }));
    const handler = builder.build();
    builder.setEnv({ flag: "after-build" });
    const response = await handler(new Request("http://x/probe"));
    expect(await response.json()).toEqual({ flag: "before-build" });
  });
});
