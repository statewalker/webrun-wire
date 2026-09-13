/**
 * The isomorphism boundary, with the platform entry points exempted BY NAME.
 *
 * The whole claim of this package is that ONE route table serves a page and a
 * server alike — twelve scenarios, run in Node and Chromium, established it.
 * So the root must reach neither platform: `./node` holds the filesystem
 * store, `./browser` holds `localStorage`, and nothing they import may leak
 * upward.
 *
 * Listing the entries by name rather than pattern-matching is deliberate: a
 * new platform file has to be added here on purpose, which is a line in a diff
 * somebody can argue with.
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

/**
 * The PLATFORM entry points, listed by name.
 *
 * `./node` exists to hold the filesystem store and `./browser` to hold
 * `localStorage`; the rule they are exempt from is the rule they exist to
 * break. Listing them rather
 * than pattern-matching is the point — a new platform file has to be added
 * here deliberately, which is a line in a diff somebody can argue with, and
 * the alternative (exempting anything matching `*-node.ts`, say) lets a file
 * become platform-bound by being renamed.
 */
const PLATFORM_ENTRIES = new Set(["node.ts", "browser.ts"]);

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

  it("every platform entry named here exists, and every one that exists is named", () => {
    // Guards the exemption itself. A name left in this list after the file is
    // gone silently widens it for a future file of the same name; a platform
    // file that is not in the list should be failing the checks below, and if
    // it is not, something else is wrong.
    const platform = named.filter((n) => PLATFORM_ENTRIES.has(n));
    expect(platform.sort()).toEqual([...PLATFORM_ENTRIES].filter((n) => named.includes(n)).sort());
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
