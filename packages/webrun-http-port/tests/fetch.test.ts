import { describe, expect, it } from "vitest";
import { fetchOverPort, serveFetchOverPort } from "../src/fetch/index.js";

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

describe("fetchOverPort / serveFetchOverPort", () => {
  it("GET round-trip", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = serveFetchOverPort(b, async (req) => {
        expect(req.method).toBe("GET");
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
      });
      try {
        const res = await fetchOverPort(a, new Request("http://x/some/path", { method: "GET" }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(await res.text()).toBe("hello");
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  it("POST with text body", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = serveFetchOverPort(b, async (req) => {
        const txt = await req.text();
        return new Response(`echo:${txt}`, { status: 200 });
      });
      try {
        const res = await fetchOverPort(
          a,
          new Request("http://x/echo", {
            method: "POST",
            body: "world",
          }),
        );
        expect(await res.text()).toBe("echo:world");
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  it("multi-value Set-Cookie round-trips via Headers", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = serveFetchOverPort(b, async () => {
        const headers = new Headers();
        headers.append("Set-Cookie", "a=1");
        headers.append("Set-Cookie", "b=2");
        return new Response("", { status: 200, headers });
      });
      try {
        const res = await fetchOverPort(a, new Request("http://x/"));
        const cookies: string[] = [];
        res.headers.forEach((v, k) => {
          if (k.toLowerCase() === "set-cookie") cookies.push(v);
        });
        // Headers may concat or split — at minimum, both values present.
        const joined = cookies.join(", ");
        expect(joined).toContain("a=1");
        expect(joined).toContain("b=2");
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });
});
