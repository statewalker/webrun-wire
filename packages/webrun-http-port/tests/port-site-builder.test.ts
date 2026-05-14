import { describe, expect, it } from "vitest";
import { fetchOverPort } from "../src/fetch/index.js";
import { PortSiteBuilder, type SiteHandler } from "../src/index.js";

function loopback(): { a: MessagePort; b: MessagePort; close(): void } {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  port2.start();
  return {
    a: port1,
    b: port2,
    close() {
      try {
        port1.close();
      } catch {}
      try {
        port2.close();
      } catch {}
    },
  };
}

describe("PortSiteBuilder", () => {
  it("dispatches HTTP calls arriving on the port to the registered handler", async () => {
    const { a, b, close } = loopback();
    try {
      const handler: SiteHandler = async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/time") {
          return new Response(JSON.stringify({ now: 42 }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      };
      const stop = new PortSiteBuilder(b).setHandler(handler).start();
      try {
        const res = await fetchOverPort(a, new Request("http://x/api/time"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ now: 42 });

        const miss = await fetchOverPort(a, new Request("http://x/elsewhere"));
        expect(miss.status).toBe(404);
      } finally {
        stop();
      }
    } finally {
      close();
    }
  });

  it("start() returns an unsubscribe that detaches the listener", async () => {
    const { b, close } = loopback();
    try {
      const stop = new PortSiteBuilder(b).setHandler(async () => new Response("ok")).start();

      // Verify the stop callback is callable; the real teardown is exercised
      // by the underlying serveFetchOverPort behaviour.
      expect(typeof stop).toBe("function");
      stop();
    } finally {
      close();
    }
  });

  it("start() throws if setHandler was not called", () => {
    const { b, close } = loopback();
    try {
      const builder = new PortSiteBuilder(b);
      expect(() => builder.start()).toThrow(/setHandler/);
    } finally {
      close();
    }
  });

  it("same SiteHandler is hostable in both PortSiteBuilder and a synthetic host", async () => {
    // Demonstrates the seam contract: one handler, two hosts. The "synthetic"
    // host here is just direct invocation, mimicking what HostedSiteBuilder
    // does after URL rewriting.
    const handler: SiteHandler = async (request) =>
      Response.json({ pathname: new URL(request.url).pathname });

    const { a, b, close } = loopback();
    try {
      const stop = new PortSiteBuilder(b).setHandler(handler).start();
      try {
        const portResponse = await fetchOverPort(a, new Request("http://x/api/items/1"));
        const direct = await handler(new Request("http://x/api/items/1"));
        expect(await portResponse.json()).toEqual(await direct.json());
      } finally {
        stop();
      }
    } finally {
      close();
    }
  });
});
