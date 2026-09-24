import path from "node:path";
import type { FileStats, FilesApi, ListOptions, ReadOptions } from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newServeFiles } from "../src/serve-files.js";
import { SiteBuilder } from "../src/site-builder.js";

/**
 * A `FilesApi` that records every path it is handed, so a test can assert on
 * the path that crosses the boundary rather than only on the response.
 *
 * Asserting on the response alone is not enough here: `MemFilesApi` keys on the
 * literal string, so a traversal path simply misses and answers 404 — the same
 * answer a correctly-rejected path produces. The recorder distinguishes
 * "rejected before the lookup" from "looked up and happened to miss".
 */
function recording(inner: FilesApi): FilesApi & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    read(p: string, options?: ReadOptions) {
      paths.push(p);
      return inner.read(p, options);
    },
    list(p: string, options?: ListOptions) {
      paths.push(p);
      return inner.list(p, options);
    },
    async stats(p: string): Promise<FileStats | undefined> {
      paths.push(p);
      return inner.stats(p);
    },
    async exists(p: string) {
      paths.push(p);
      return inner.exists(p);
    },
    write: (p, c) => inner.write(p, c),
    mkdir: (p) => inner.mkdir(p),
    remove: (p) => inner.remove(p),
    move: (s, t) => inner.move(s, t),
    copy: (s, t) => inner.copy(s, t),
  };
}

/**
 * A `FilesApi` that models a root-anchored backend the way
 * `@statewalker/webrun-files-node` actually resolves paths:
 * `rootDir + normalizePath(virtualPath)`, then real filesystem semantics.
 *
 * `normalizePath` does NOT resolve `..` (it only drops `.` and empty
 * segments), so the `..` survives into the concatenated path and the
 * filesystem resolves it — which is a real escape out of the root. The
 * `path.posix.normalize` here is what stands in for the filesystem.
 *
 * A `MemFilesApi` cannot show this, because it keys on the literal string:
 * `/site/../secret.txt` is simply a key nobody wrote. This backend genuinely
 * escapes, so a traversal that gets through returns the secret.
 */
function rooted(root: string, disk: Record<string, string>): FilesApi {
  const resolve = (p: string): string => path.posix.normalize(root + normalizePath(p));
  const get = (p: string): string | undefined => disk[resolve(p)];
  const notImplemented = () => {
    throw new Error("not used by these tests");
  };
  return {
    async *read(p: string) {
      const content = get(p);
      if (content !== undefined) yield new TextEncoder().encode(content);
    },
    async *list() {},
    async stats(p: string): Promise<FileStats | undefined> {
      const content = get(p);
      if (content === undefined) return undefined;
      return { kind: "file", size: new TextEncoder().encode(content).length, lastModified: 0 };
    },
    async exists(p: string) {
      return get(p) !== undefined;
    },
    write: notImplemented,
    mkdir: notImplemented,
    remove: notImplemented,
    move: notImplemented,
    copy: notImplemented,
  };
}

async function populate(api: MemFilesApi, entries: Record<string, string>): Promise<void> {
  for (const [p, content] of Object.entries(entries)) {
    await api.write(p, [new TextEncoder().encode(content)]);
  }
}

const SECRET = "TOP-SECRET";
const DISK = {
  "/srv/site/index.html": "<h1>home</h1>",
  "/srv/secret.txt": SECRET,
  "/secret.txt": SECRET,
};

describe("percent-decoding: the path is decoded before the FilesApi lookup", () => {
  it("serves a file whose stored name contains a space", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/My Report.html": "<h1>report</h1>" });
    const serve = newServeFiles(api);
    // What `new URL("http://x/My Report.html").pathname` actually is.
    const response = await serve(new Request("http://x/"), "/My%20Report.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>report</h1>");
  });

  it("serves a file whose stored name is non-ASCII", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/Über Bericht.html": "ok" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/%C3%9Cber%20Bericht.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("serves a file whose stored name contains #", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/notes #1.html": "hash" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/notes%20%231.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hash");
  });

  it("leaves + and & alone (a path + is a literal plus, not a space)", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/a+b&c.html": "plus" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/a+b&c.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("plus");
  });

  it("decodes directory segments too, including the directoryIndex fallback", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/My Notes/index.html": "dir" });
    const serve = newServeFiles(api, { directoryIndex: "index.html" });
    const response = await serve(new Request("http://x/"), "/My%20Notes");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dir");
  });

  it("decodes end-to-end through SiteBuilder, under a mount prefix", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/My Report.html": "<h1>report</h1>" });
    const handler = new SiteBuilder().setFiles("/site", api).build();
    const response = await handler(new Request("http://x/site/My%20Report.html"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>report</h1>");
  });

  it("decodes exactly once — a double-encoded sequence stays encoded", async () => {
    const api = recording(new MemFilesApi());
    const serve = newServeFiles(api);
    await serve(new Request("http://x/"), "/%252e%252e%252fsecret.txt");
    // One decode turns %25 into %; it must not then decode %2e%2e%2f into ../.
    expect(api.paths).toEqual(["/%2e%2e%2fsecret.txt"]);
  });
});

describe("percent-decoding: traversal guard", () => {
  // Each entry is a request path that must never reach the FilesApi.
  const rejected: Array<[string, string]> = [
    ["encoded dots and an encoded separator", "/%2e%2e%2f%2e%2e%2fsecret.txt"],
    ["encoded dot-segment with real separators", "/%2e%2e/%2e%2e/secret.txt"],
    ["mixed-case encoded dots", "/%2E%2e/secret.txt"],
    ["a raw dot-segment", "/../secret.txt"],
    ["a raw single-dot segment", "/./index.html"],
    ["a half-encoded dot-segment", "/.%2e/secret.txt"],
    ["an encoded backslash", "/%5c..%5c..%5csecret.txt"],
    ["a raw backslash", "/..\\..\\secret.txt"],
    ["an encoded separator inside a segment", "/a%2fb/secret.txt"],
    ["an encoded NUL", "/index.html%00.png"],
  ];

  for (const [label, requestPath] of rejected) {
    it(`never hands ${label} to the FilesApi`, async () => {
      const api = recording(new MemFilesApi());
      const serve = newServeFiles(api);
      const response = await serve(new Request("http://x/"), requestPath);
      expect(api.paths).toEqual([]);
      expect(response.status).toBe(404);
    });

    it(`does not escape the root with ${label}`, async () => {
      const serve = newServeFiles(rooted("/srv/site", DISK));
      const response = await serve(new Request("http://x/"), requestPath);
      const body = await response.text();
      expect(body).not.toContain(SECRET);
      expect(response.status).toBe(404);
    });
  }

  it("the escaping backend really does escape (the fixture is load-bearing)", async () => {
    const api = rooted("/srv/site", DISK);
    // Fed the decoded form directly, this backend leaks — which is exactly why
    // decoding without a guard would be a vulnerability rather than a bugfix.
    expect(await api.stats("/../secret.txt")).toBeDefined();
    expect(await api.stats("/index.html")).toBeDefined();
  });
});

describe("percent-decoding: malformed sequences", () => {
  it("serves a file whose stored name contains a literal % (a broken escape)", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/broken%zz.html": "raw" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/broken%zz.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("raw");
  });

  it("serves a file whose stored name ends in a lone %", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/100%.html": "pct" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/100%.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pct");
  });

  it("answers 404, not 500, for a truncated UTF-8 escape", async () => {
    const api = new MemFilesApi();
    const serve = newServeFiles(api, { directoryIndex: "index.html" });
    const response = await serve(new Request("http://x/"), "/%e0%a4%a");
    expect(response.status).toBe(404);
  });

  it("a malformed escape does not throw out of the SiteBuilder handler", async () => {
    const api = new MemFilesApi();
    await populate(api, { "/index.html": "home" });
    let errors = 0;
    const handler = new SiteBuilder()
      .setFiles("/", api)
      .setErrorHandler(() => {
        errors += 1;
        return new Response("boom", { status: 500 });
      })
      .build();
    const response = await handler(new Request("http://x/%zz"));
    expect(errors).toBe(0);
    expect(response.status).toBe(404);
  });
});
