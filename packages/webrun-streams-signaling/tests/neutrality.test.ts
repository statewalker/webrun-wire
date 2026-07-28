import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Allowed bare (non-relative) import specifiers for the package src. */
const ALLOWED_BARE = new Set(["@statewalker/webrun-streams", "livekit-client", "peerjs"]);

const IMPORT_RE = /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;

describe("dependency neutrality", () => {
  it("src imports only webrun-streams + optional vendor peer-deps; no vcs/git coupling", () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      IMPORT_RE.lastIndex = 0;
      let match: RegExpExecArray | null = IMPORT_RE.exec(content);
      while (match !== null) {
        const spec = match[1];
        if (!spec.startsWith("./") && !spec.startsWith("../")) {
          expect(ALLOWED_BARE.has(spec), `${file} imports disallowed "${spec}"`).toBe(true);
        }
        // No import ever reaches back into a vcs/git package.
        expect(/vcs|\bgit\b/i.test(spec), `${file} imports vcs/git "${spec}"`).toBe(false);
        match = IMPORT_RE.exec(content);
      }
    }
  });
});
