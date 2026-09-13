/**
 * The isomorphism boundary — and now there is only one entry to hold to it.
 *
 * The platform entries are GONE, not exempted: `./node` and `./browser` held
 * route stores, and persisting route configuration left with the router. What
 * remains is `urlUpstream`, which touches no filesystem and no browser
 * storage, so the package is isomorphic with nothing to carve out.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** Anything that pins this package to one runtime. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["a node: builtin", /from\s+["']node:/],
  ["libp2p", /from\s+["']libp2p["']/],
  ["@libp2p/*", /from\s+["']@libp2p\//],
  ["biscuit-wasm", /from\s+["']@biscuit-auth\//],
];

/**
 * DOM-ONLY globals.
 *
 * `Request`, `Response`, `Headers`, `URL`, `AbortController` and `AbortSignal`
 * are deliberately absent from this list: they are WinterCG, present in Node,
 * Deno, Bun, browsers and workers alike, and this package is built on them.
 * Confusing "browser API" with "DOM API" is what would make this list wrong.
 */
const DOM_ONLY = /\b(document|window|navigator|localStorage|sessionStorage)\b/;

/** None. Every file here must pass every check — see the header. */
const PLATFORM_ENTRIES = new Set<string>();

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

/** Strip comments: they legitimately discuss browsers, and a false positive here teaches people to weaken the test. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("the isomorphism boundary", () => {
  const files = sources(SRC);
  const named = files.map((f) => f.slice(SRC.length + 1));

  it("finds the source files at all", () => {
    // GUARDS THE GUARD. A scan that matches nothing makes every check below
    // pass while measuring nothing — the shape of vacuous test that is worse
    // than no test, because it reports safety.
    expect(files.length).toBeGreaterThan(1);
    expect(named).toContain("index.ts");
  });

  it("has no platform entry points left to exempt", () => {
    // The stores went with the router. If a `node.ts` or `browser.ts` comes
    // back, it is a design event and this says so rather than quietly
    // exempting it.
    expect(PLATFORM_ENTRIES.size).toBe(0);
    expect(named).not.toContain("node.ts");
    expect(named).not.toContain("browser.ts");
  });

  for (const file of files) {
    const name = file.slice(SRC.length + 1);
    it.skipIf(PLATFORM_ENTRIES.has(name))(`${name} imports no platform`, () => {
      const code = codeOf(file);
      for (const [what, pattern] of FORBIDDEN) {
        expect(code, `${name} imports ${what}`).not.toMatch(pattern);
      }
    });

    // Skipped for the platform entries for the same reason as the imports
    // above: `./browser` exists to touch `localStorage`, and a rule that
    // forbade it there would forbid the file's whole purpose.
    it.skipIf(PLATFORM_ENTRIES.has(name))(`${name} touches no DOM-only global`, () => {
      expect(codeOf(file), name).not.toMatch(DOM_ONLY);
    });
  }

  it("depends on nothing at all", () => {
    // The boundary is a package.json claim too. A dependency appearing here is
    // a design decision, and should fail until somebody makes it deliberately.
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // ZERO RUNTIME DEPENDENCIES, which is stronger than this had inside
    // httpeers: the single import it carried was `FetchHandler`, a one-line
    // type, so extracting it DROPPED the dependency rather than moving it.
    // Proxying needs no transport, no crypto and no platform, which is why the
    // same package serves a page and a Node process.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([]);
  });
});
