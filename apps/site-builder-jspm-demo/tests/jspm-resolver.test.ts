import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeAll, describe, expect, it } from "vitest";
import { JspmResolver } from "../src/jspm-resolver.js";
import { init } from "../src/lex-rewrite.js";
import { transformSource } from "../src/script-transform.js";
import { clientResources } from "../src/site.js";

const NETWORK_TESTS = process.env.JSPM_DEMO_NETWORK === "1";

beforeAll(async () => {
  await init;
});

async function makeFs(record: Record<string, string>): Promise<MemFilesApi> {
  const fs = new MemFilesApi();
  for (const [path, content] of Object.entries(record)) {
    await fs.write(path, [new TextEncoder().encode(content)]);
  }
  return fs;
}

describe("automatic JSX runtime → react/jsx-runtime is discoverable", () => {
  it("emits an implicit import of react/jsx-runtime for .tsx", () => {
    const code = transformSource(
      "/client/main.tsx",
      "export const X = (): JSX.Element => <p>hi</p>;",
    );
    // sucrase's automatic-runtime output references react/jsx-runtime.
    expect(code).toContain("react/jsx-runtime");
    // Verify it's an import statement, not just a string.
    expect(code).toMatch(/from\s+["']react\/jsx-runtime["']/);
  });
});

describe("bare-specifier validation (no network)", () => {
  it("throws with a clear diagnostic when source uses a bare specifier not in package.json", async () => {
    const sources = await makeFs({
      "/main.ts": 'import { something } from "left-pad";\nexport const x = something;',
    });
    const resolver = new JspmResolver()
      .setSiteKey("test")
      .setPackageJson({ dependencies: { react: "18.3.1" } })
      .addSource("/client", sources);

    await expect(resolver.resolveAndPrefetch()).rejects.toThrow(
      /Bare specifier "left-pad".*not listed.*dependencies/,
    );
  });

  it("throws even when only a subpath of an unlisted package is used", async () => {
    const sources = await makeFs({
      "/main.ts": 'import { z } from "zod/lib/types";\nexport const x = z;',
    });
    const resolver = new JspmResolver()
      .setSiteKey("test")
      .setPackageJson({ dependencies: {} })
      .addSource("/client", sources);

    await expect(resolver.resolveAndPrefetch()).rejects.toThrow(
      /Bare specifier "zod\/lib\/types".*package "zod".*not listed/,
    );
  });

  it("refuses to run without setPackageJson", async () => {
    const sources = await makeFs({ "/x.ts": "export const x = 1;" });
    const resolver = new JspmResolver().setSiteKey("test").addSource("/client", sources);
    await expect(resolver.resolveAndPrefetch()).rejects.toThrow(/setPackageJson.*not called/);
  });

  it("refuses to run without any source mount", async () => {
    const resolver = new JspmResolver().setSiteKey("test").setPackageJson({ dependencies: {} });
    await expect(resolver.resolveAndPrefetch()).rejects.toThrow(/at least one addSource/);
  });
});

describe("manifest as sidecar (static checks)", () => {
  it('the iframe-served client HTML contains no <script type="importmap"> element', () => {
    const html = clientResources["/index.html"];
    expect(html).toBeTypeOf("string");
    expect(html).not.toMatch(/<script[^>]+type\s*=\s*["']importmap/);
    expect(html).not.toMatch(/<script[^>]+type\s*=\s*["']importmap-shim/);
  });
});

const itNet = NETWORK_TESTS ? it : it.skip;

describe.concurrent("end-to-end with JSPM network (gated by JSPM_DEMO_NETWORK=1)", () => {
  itNet(
    "resolves react + zod, lands every transitive dep under /external/, and writes a sidecar manifest",
    async () => {
      const client = await makeFs({
        "/main.tsx":
          'import { useState } from "react";\nimport { createRoot } from "react-dom/client";\nexport function X(){ const [v]=useState(0); return v; } void createRoot;',
      });
      const server = await makeFs({
        "/api/index.ts":
          'import { z } from "zod";\nexport default async () => z.object({ name: z.string() });',
      });
      const resolver = new JspmResolver()
        .setSiteKey("test")
        .setPackageJson({
          dependencies: { react: "18.3.1", "react-dom": "18.3.1", zod: "3.23.8" },
        })
        .addSource("/client", client)
        .addSource("/server", server);
      const { outputs, external, manifest } = await resolver.resolveAndPrefetch();

      // (a) manifest contains exactly the discovered first-party specifiers
      expect(Object.keys(manifest.imports).sort()).toEqual([
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "zod",
      ]);

      // (b) every manifest value is a relative path
      for (const v of Object.values(manifest.imports)) {
        expect(v).toMatch(/^\.\.?\//);
      }

      // (c) external contains at least one file for each top-level dep
      const externalFiles: string[] = [];
      for await (const entry of external.list("/", { recursive: true })) {
        if (entry.kind === "file") externalFiles.push(entry.path);
      }
      expect(externalFiles.some((p) => p.startsWith("/react@"))).toBe(true);
      expect(externalFiles.some((p) => p.startsWith("/react-dom@"))).toBe(true);
      expect(externalFiles.some((p) => p.startsWith("/zod@"))).toBe(true);

      // (d) no ga.jspm.io string survives in served bytes
      const clientOut = outputs.get("/client");
      if (!clientOut) throw new Error("no client output");
      const main = new TextDecoder().decode(
        await new Response(clientOut.read("/main.js")).arrayBuffer().then((b) => new Uint8Array(b)),
      );
      expect(main).not.toContain("ga.jspm.io");
      for (const f of externalFiles) {
        const buf = await new Response(external.read(f)).arrayBuffer();
        const text = new TextDecoder().decode(buf);
        expect(text).not.toContain("ga.jspm.io");
      }

      // (e) first-party imports use relative paths into ../external/
      expect(main).toMatch(/\.\.?\/external\/react@/);
    },
    60_000,
  );
});
