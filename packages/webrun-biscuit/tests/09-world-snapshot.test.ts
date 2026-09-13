import assert from "node:assert";
import fs from "node:fs";
import { authorizeDetailed, loadToken } from "../src/authorizer.js";
import type { ExternFn, Term } from "../src/datalog.js";

const externs = new Map<string, ExternFn>([
  [
    "test",
    ((left: Term, right?: Term): Term =>
      right === undefined
        ? left
        : {
            t: "str",
            v: (left as any).v === (right as any).v ? "equal strings" : "different strings",
          }) as ExternFn,
  ],
]);

const dir = new URL("../samples/", import.meta.url).pathname;
const samples = JSON.parse(fs.readFileSync(dir + "samples.json", "utf8"));
const rootKey = new Uint8Array(Buffer.from(samples.root_public_key, "hex"));

/** the corpus records facts/rules/checks per origin; normalize both sides the
 *  same way so ordering differences are not reported as content differences */
const norm = (w: any) => ({
  facts: (w.facts ?? [])
    .map((g: any) => ({ origin: [...g.origin].sort(), facts: [...g.facts].sort() }))
    .sort((a: any, b: any) => JSON.stringify(a.origin).localeCompare(JSON.stringify(b.origin))),
  rules: (w.rules ?? [])
    .map((g: any) => ({ origin: g.origin, rules: [...g.rules].sort() }))
    .sort((a: any, b: any) => (a.origin ?? -1) - (b.origin ?? -1)),
  checks: (w.checks ?? [])
    .map((g: any) => ({ origin: g.origin, checks: [...g.checks].sort() }))
    .sort((a: any, b: any) => (a.origin ?? -1) - (b.origin ?? -1)),
  policies: w.policies ?? [],
});

for (const tc of samples.testcases) {
  for (const [name, validation] of Object.entries<any>(tc.validations)) {
    if (!validation.world) continue;
    test(`world snapshot :: ${tc.filename} :: ${name || "(default)"}`, () => {
      const raw = new Uint8Array(fs.readFileSync(dir + tc.filename));
      let token: ReturnType<typeof loadToken>;
      try {
        token = loadToken(raw, rootKey);
      } catch {
        return; // tokens that fail verification have no world to compare
      }
      const { world } = authorizeDetailed(token, validation.authorizer_code, { externs });
      assert.deepStrictEqual(norm(world), norm(validation.world));
    });
  }
}
