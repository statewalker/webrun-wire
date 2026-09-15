/**
 * The parser's name and arity rules against the reference itself.
 *
 * `tests/grammar-cases.ts` records what the reference decided; this re-asks it
 * for every row, and then for generated names, so neither the table nor our
 * parser can drift from the reference unnoticed.
 */
import assert from "node:assert";
import { parse } from "../../src/parser.js";
import { GRAMMAR_CASES } from "../grammar-cases.js";
import { loadReference, type Reference } from "./reference.js";

const ref: Reference | null = await loadReference();

const referenceAccepts = (kind: "Fact" | "Rule" | "Check", source: string): boolean => {
  try {
    (ref as any)[kind].fromString(source);
    return true;
  } catch {
    return false;
  }
};
const weAccept = (source: string): boolean => {
  try {
    parse(`${source};`);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(!ref)("the recorded grammar table is still what the reference decides", () => {
  const stale = GRAMMAR_CASES.filter((c) => referenceAccepts(c.kind, c.source) !== c.accepted);
  assert.deepStrictEqual(stale, []);
});

test.skipIf(!ref)("generated predicate and variable names parse exactly when the reference parses them", () => {
  const alphabet = ["a", "Z", "0", "9", "_", ":", "-", ".", "ä", "$", " "];
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const disagreements: string[] = [];
  for (let i = 0; i < 400; i++) {
    const length = 1 + Math.floor(next() * 4);
    const name = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    const cases: ["Fact" | "Rule", string][] = [
      ["Fact", `${name}(1)`],
      ["Rule", `h($${name}) <- a($${name})`],
    ];
    for (const [kind, source] of cases) {
      if (referenceAccepts(kind, source) !== weAccept(source)) {
        disagreements.push(`${kind} ${JSON.stringify(source)}: reference ${referenceAccepts(kind, source)}`);
      }
    }
  }
  assert.deepStrictEqual(disagreements, []);
});
