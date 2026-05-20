import { beforeAll, describe, expect, it } from "vitest";
import { discoverSpecifiers, init, relativePath, rewriteImports } from "../src/lex-rewrite.js";

beforeAll(async () => {
  await init;
});

describe("relativePath", () => {
  it("walks up from a single-segment dir to a sibling top-level dir", () => {
    expect(relativePath("/client/main.js", "/external/react@18.3.1/index.js")).toBe(
      "../external/react@18.3.1/index.js",
    );
  });

  it("resolves siblings inside the same directory with ./", () => {
    expect(
      relativePath("/external/react@18.3.1/index.js", "/external/react@18.3.1/jsx-runtime.js"),
    ).toBe("./jsx-runtime.js");
  });

  it("hops from one /external/ package to another", () => {
    expect(
      relativePath("/external/react-dom@18.3.1/client.js", "/external/scheduler@0.23.2/index.js"),
    ).toBe("../scheduler@0.23.2/index.js");
  });

  it("walks up multiple levels from a deeply-nested CDN file to a peer package", () => {
    expect(
      relativePath(
        "/external/react@18.3.1/cjs/react.development.js",
        "/external/scheduler@0.23.2/index.js",
      ),
    ).toBe("../../scheduler@0.23.2/index.js");
  });

  it("handles deeper-than-current-dir targets", () => {
    expect(relativePath("/client/main.js", "/client/nested/deep/helper.js")).toBe(
      "./nested/deep/helper.js",
    );
  });
});

describe("discoverSpecifiers", () => {
  it("collects unique static specifiers", () => {
    const code = [
      'import React from "react";',
      'import { useState } from "react";',
      'import { z } from "zod";',
      'import "./style.css";',
    ].join("\n");
    expect(discoverSpecifiers(code).sort()).toEqual(["./style.css", "react", "zod"]);
  });

  it("includes string-literal dynamic imports", () => {
    const code = 'const m = await import("lodash-es/uniq");';
    expect(discoverSpecifiers(code)).toEqual(["lodash-es/uniq"]);
  });

  it("ignores dynamic imports with non-literal arguments", () => {
    const code = 'const m = await import("./" + name + ".js");';
    expect(discoverSpecifiers(code)).toEqual([]);
  });
});

describe("rewriteImports", () => {
  it("replaces each specifier exactly once with the mapper's output", () => {
    const code = ['import React from "react";', 'import { z } from "zod";'].join("\n");
    const out = rewriteImports(code, (raw) =>
      raw === "react"
        ? "../external/react@18.3.1/index.js"
        : raw === "zod"
          ? "../external/zod@3.23.8/index.js"
          : raw,
    );
    expect(out).toContain('from "../external/react@18.3.1/index.js"');
    expect(out).toContain('from "../external/zod@3.23.8/index.js"');
    expect(out).not.toContain('"react"');
    expect(out).not.toContain('"zod"');
  });

  it("leaves specifiers untouched when the mapper returns input identity", () => {
    const code = 'import "./style.css";\nimport "react";\n';
    const out = rewriteImports(code, (raw) => raw);
    expect(out).toBe(code);
  });

  it("preserves total character ordering across multiple rewrites", () => {
    const code = ['import a from "alpha";', 'import b from "beta";', 'import c from "gamma";'].join(
      "\n",
    );
    const out = rewriteImports(code, (raw) => `mapped:${raw}`);
    const aIdx = out.indexOf("mapped:alpha");
    const bIdx = out.indexOf("mapped:beta");
    const cIdx = out.indexOf("mapped:gamma");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it("handles dynamic import string-literal arguments", () => {
    const code = 'const m = await import("react");';
    const out = rewriteImports(code, (raw) =>
      raw === "react" ? "../external/react@18.3.1/index.js" : raw,
    );
    expect(out).toBe('const m = await import("../external/react@18.3.1/index.js");');
  });
});
