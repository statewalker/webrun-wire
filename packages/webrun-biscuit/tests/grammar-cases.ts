/**
 * Names and arity, as the reference parser decides them.
 *
 * Every `accepted` value below was read from `@biscuit-auth/biscuit-wasm@0.6.0`
 * (`Fact` / `Rule` / `Check.fromString`) on 2026-09-15, not inferred from the
 * specification. `tests/cross/05-grammar.test.ts` re-asks the reference for each
 * row, so a row that stops matching it fails there rather than drifting here.
 *
 * The rule they add up to: a predicate or variable name is one or more of
 * `[A-Za-z0-9_:]` — ASCII only, and any of them may come first — and a predicate
 * carries at least one term.
 */
export const GRAMMAR_CASES: { kind: "Fact" | "Rule" | "Check"; source: string; accepted: boolean }[] =
  [
    { kind: "Rule", source: '_m(true) <- selection("file")', accepted: true },
    { kind: "Rule", source: '_m() <- selection("file")', accepted: false },
    { kind: "Fact", source: "_private(1)", accepted: true },
    { kind: "Fact", source: "f()", accepted: false },
    { kind: "Check", source: "check if f()", accepted: false },
    { kind: "Check", source: "check if _x(1)", accepted: true },
    { kind: "Fact", source: "a:b(1)", accepted: true },
    { kind: "Fact", source: "a_b(1)", accepted: true },
    { kind: "Fact", source: "_(1)", accepted: true },
    { kind: "Fact", source: "__(1)", accepted: true },
    { kind: "Fact", source: "1a(1)", accepted: true },
    { kind: "Fact", source: "123(1)", accepted: true },
    { kind: "Fact", source: ":a(1)", accepted: true },
    { kind: "Fact", source: "::(1)", accepted: true },
    { kind: "Fact", source: "A(1)", accepted: true },
    { kind: "Fact", source: "ärger(1)", accepted: false },
    { kind: "Fact", source: "a-b(1)", accepted: false },
    { kind: "Fact", source: "a.b(1)", accepted: false },
    { kind: "Fact", source: "a(1, )", accepted: false },
    { kind: "Fact", source: "a( 1 )", accepted: true },
    { kind: "Rule", source: "h($x) <- a($x)", accepted: true },
    { kind: "Rule", source: "h($_x) <- a($_x)", accepted: true },
    { kind: "Rule", source: "h($1) <- a($1)", accepted: true },
    { kind: "Rule", source: "h($a:b) <- a($a:b)", accepted: true },
    { kind: "Rule", source: "h($ä) <- a($ä)", accepted: false },
    { kind: "Rule", source: "h($a-b) <- a($a-b)", accepted: false },
    { kind: "Rule", source: "h($ x) <- a($ x)", accepted: false },
    { kind: "Rule", source: "h(1) <- a(1), 1a(2)", accepted: true },
    { kind: "Check", source: "check if a(1), true", accepted: true },
    { kind: "Check", source: "check if 1 < 2", accepted: true },
    { kind: "Check", source: "check if a(1) or b(2)", accepted: true },
  ];
