import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { newServeFiles } from "../src/serve-files.js";

async function populate(
  api: MemFilesApi,
  entries: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [path, content] of Object.entries(entries)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await api.write(path, [bytes]);
  }
}

describe("newServeFiles", () => {
  let api: MemFilesApi;
  beforeEach(() => {
    api = new MemFilesApi();
  });

  it("streams a file with the right Content-Type and Content-Length", async () => {
    await populate(api, { "/index.html": "<h1>ok</h1>" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/index.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Length")).toBe("11");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await response.text()).toBe("<h1>ok</h1>");
  });

  it("returns 404 for a missing path", async () => {
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/missing.txt");
    expect(response.status).toBe(404);
  });

  it("returns 404 for a directory path when directoryIndex is not set (default)", async () => {
    await populate(api, { "/site/index.html": "<p>home</p>" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/site");
    expect(response.status).toBe(404);
    // The file itself is still reachable by its full path.
    const direct = await serve(new Request("http://x/"), "/site/index.html");
    expect(await direct.text()).toBe("<p>home</p>");
  });

  it("serves the configured directoryIndex when opted in", async () => {
    await populate(api, { "/site/index.html": "<p>home</p>" });
    const serve = newServeFiles(api, { directoryIndex: "index.html" });
    const response = await serve(new Request("http://x/"), "/site");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<p>home</p>");
  });

  it("honours a custom directoryIndex name", async () => {
    await populate(api, { "/d/start.html": "<p>start</p>" });
    const serve = newServeFiles(api, { directoryIndex: "start.html" });
    const response = await serve(new Request("http://x/"), "/d");
    expect(await response.text()).toBe("<p>start</p>");
  });

  it("returns 404 when directoryIndex is set but the index file is missing", async () => {
    await populate(api, { "/empty/other.txt": "hi" });
    const serve = newServeFiles(api, { directoryIndex: "index.html" });
    const response = await serve(new Request("http://x/"), "/empty");
    expect(response.status).toBe(404);
  });

  it("HEAD returns the headers but no body", async () => {
    await populate(api, { "/a.txt": "hello" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/", { method: "HEAD" }), "/a.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.body).toBeNull();
  });

  it("rejects unsupported methods with 405 + Allow header", async () => {
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/", { method: "POST" }), "/a.txt");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("serves a Range: bytes=<start>-<end> slice as 206 Partial Content", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    const serve = newServeFiles(api);
    const request = new Request("http://x/", { headers: { Range: "bytes=2-5" } });
    const response = await serve(request, "/data.bin");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([3, 4, 5, 6]);
  });

  it("handles a suffix range (bytes=-N)", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3, 4, 5]) });
    const serve = newServeFiles(api);
    const response = await serve(
      new Request("http://x/", { headers: { Range: "bytes=-2" } }),
      "/data.bin",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 3-4/5");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([4, 5]);
  });

  it("handles an open-ended range (bytes=N-)", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3, 4, 5]) });
    const serve = newServeFiles(api);
    const response = await serve(
      new Request("http://x/", { headers: { Range: "bytes=3-" } }),
      "/data.bin",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 3-4/5");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([4, 5]);
  });

  it("rejects an out-of-bounds range with 416", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3]) });
    const serve = newServeFiles(api);
    const response = await serve(
      new Request("http://x/", { headers: { Range: "bytes=10-20" } }),
      "/data.bin",
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */3");
  });

  it("allows a custom MIME resolver", async () => {
    await populate(api, { "/weird.abc": "hello" });
    const serve = newServeFiles(api, {
      getMimeType: () => "application/x-test",
    });
    const response = await serve(new Request("http://x/"), "/weird.abc");
    expect(response.headers.get("Content-Type")).toBe("application/x-test");
  });

  describe("transform", () => {
    it("returning the response unchanged is a no-op (passes through Range/HEAD/200)", async () => {
      await populate(api, { "/a.txt": "hello" });
      const serve = newServeFiles(api, { transform: (_req, res) => res });

      const ok = await serve(new Request("http://x/"), "/a.txt");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(ok.headers.get("Accept-Ranges")).toBe("bytes");
      expect(await ok.text()).toBe("hello");

      const ranged = await serve(
        new Request("http://x/", { headers: { Range: "bytes=0-2" } }),
        "/a.txt",
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("Content-Range")).toBe("bytes 0-2/5");
    });

    it("substitutes body and Content-Type when filter returns a new response", async () => {
      await populate(api, { "/main.tsx": "const x: number = 1; export {};" });
      const serve = newServeFiles(api, {
        transform: async (_req, res) => {
          if (res.status !== 200) return res;
          const src = await res.text();
          return new Response(`/* transformed */ ${src}`, {
            status: 200,
            headers: { "Content-Type": "text/javascript" },
          });
        },
      });
      const response = await serve(new Request("http://x/"), "/main.tsx");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/javascript");
      expect(response.headers.get("Content-Range")).toBeNull();
      expect(await response.text()).toBe("/* transformed */ const x: number = 1; export {};");
    });

    it("filter sees the original Request (URL + method)", async () => {
      await populate(api, { "/x.txt": "hi" });
      let seenUrl = "";
      let seenMethod = "";
      const serve = newServeFiles(api, {
        transform: (req, res) => {
          seenUrl = req.url;
          seenMethod = req.method;
          return res;
        },
      });
      await serve(new Request("http://example/req-url", { method: "GET" }), "/x.txt");
      expect(seenUrl).toBe("http://example/req-url");
      expect(seenMethod).toBe("GET");
    });

    it("synchronous throw propagates", async () => {
      await populate(api, { "/a.txt": "hello" });
      const serve = newServeFiles(api, {
        transform: () => {
          throw new Error("boom");
        },
      });
      await expect(serve(new Request("http://x/"), "/a.txt")).rejects.toThrow("boom");
    });

    it("rejected promise propagates", async () => {
      await populate(api, { "/a.txt": "hello" });
      const serve = newServeFiles(api, {
        transform: () => Promise.reject(new Error("boom")),
      });
      await expect(serve(new Request("http://x/"), "/a.txt")).rejects.toThrow("boom");
    });

    it("invokes filter for 405 (filter can pass through)", async () => {
      const calls: number[] = [];
      const serve = newServeFiles(api, {
        transform: (_req, res) => {
          calls.push(res.status);
          return res;
        },
      });
      const response = await serve(new Request("http://x/", { method: "POST" }), "/a.txt");
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expect(calls).toEqual([405]);
    });

    it("invokes filter for 416 (filter can pass through)", async () => {
      await populate(api, { "/data.bin": new Uint8Array([1, 2, 3]) });
      const calls: number[] = [];
      const serve = newServeFiles(api, {
        transform: (_req, res) => {
          calls.push(res.status);
          return res;
        },
      });
      const response = await serve(
        new Request("http://x/", { headers: { Range: "bytes=10-20" } }),
        "/data.bin",
      );
      expect(response.status).toBe(416);
      expect(calls).toEqual([416]);
    });

    it("invokes filter for HEAD", async () => {
      await populate(api, { "/a.txt": "hello" });
      let invoked = false;
      const serve = newServeFiles(api, {
        transform: (_req, res) => {
          invoked = true;
          return res;
        },
      });
      const response = await serve(new Request("http://x/", { method: "HEAD" }), "/a.txt");
      expect(invoked).toBe(true);
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
    });
  });
});
