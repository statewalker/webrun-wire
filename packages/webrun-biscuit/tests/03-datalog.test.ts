import assert from "node:assert";
import {
  BinaryOp as B,
  ExecutionError,
  evaluateExpression,
  type Op,
  Origin,
  type Rule,
  type Term,
  TrustedOrigins,
  UnaryOp as U,
  World,
} from "../src/datalog.js";

const str = (v: string): Term => ({ t: "str", v });
const int = (v: bigint | number): Term => ({ t: "int", v: BigInt(v) });
const vr = (v: number): Term => ({ t: "var", v });
const fact = (name: string, ...terms: Term[]) => ({ predicate: { name, terms } });
const rule = (head: any, body: any[], expressions: Op[][] = []): Rule => ({
  head,
  body,
  expressions,
  scopes: [],
});
const pred = (name: string, ...terms: Term[]) => ({ name, terms });

function world(): World {
  const w = new World();
  return w;
}
const O0 = Origin.of(0);
const ALL = new TrustedOrigins([0, 1, 2, 0xffffffff]);

// ported from datalog::tests::family
test("transitive rules reach a fixpoint (family)", () => {
  const w = world();
  for (const [a, b] of [
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
  ])
    w.addFact(O0, fact("parent", str(a), str(b)));
  w.addRule(
    0,
    ALL,
    rule(pred("grandparent", vr(1), vr(3)), [
      pred("parent", vr(1), vr(2)),
      pred("parent", vr(2), vr(3)),
    ]),
  );
  w.run();
  const names = [...w.facts.values()]
    .flatMap((b) => [...b.items.keys()])
    .filter((k) => k.startsWith("grandparent"))
    .sort();
  assert.deepEqual(names, ["grandparent/2(s1:A,s1:C)", "grandparent/2(s1:B,s1:D)"]);
});

// ported from datalog::tests::numbers / resource
test("rules join facts and bind variables", () => {
  const w = world();
  w.addFact(O0, fact("t1", int(0), str("A")));
  w.addFact(O0, fact("t1", int(1), str("B")));
  w.addFact(O0, fact("t2", int(0), str("D")));
  w.addRule(
    0,
    ALL,
    rule(pred("join", vr(2), vr(3)), [pred("t1", vr(1), vr(2)), pred("t2", vr(1), vr(3))]),
  );
  w.run();
  const joins = [...w.facts.values()]
    .flatMap((b) => [...b.items.keys()])
    .filter((k) => k.startsWith("join"));
  assert.deepEqual(joins, ["join/2(s1:A,s1:D)"]);
});

test("expressions filter rule application", () => {
  const w = world();
  for (const n of [1, 2, 3]) w.addFact(O0, fact("n", int(n)));
  const gt1: Op[] = [
    { kind: "value", value: vr(1) },
    { kind: "value", value: int(1) },
    { kind: "binary", op: B.GreaterThan },
  ];
  w.addRule(0, ALL, rule(pred("big", vr(1)), [pred("n", vr(1))], [gt1]));
  w.run();
  const big = [...w.facts.values()]
    .flatMap((b) => [...b.items.keys()])
    .filter((k) => k.startsWith("big"))
    .sort();
  assert.deepEqual(big, ["big/1(i2)", "big/1(i3)"]);
});

// ported from datalog::tests::unbound_variables
test("a head variable not bound in the body produces no fact", () => {
  const w = world();
  w.addFact(O0, fact("n", int(1)));
  w.addRule(0, ALL, rule(pred("out", vr(9)), [pred("n", vr(1))]));
  w.run();
  const out = [...w.facts.values()]
    .flatMap((b) => [...b.items.keys()])
    .filter((k) => k.startsWith("out"));
  assert.deepEqual(out, []);
});

test("facts are tagged with the union of matched origins", () => {
  const w = world();
  w.addFact(Origin.of(0), fact("a", int(1)));
  w.addFact(Origin.of(1), fact("b", int(1)));
  w.addRule(2, ALL, rule(pred("c", vr(1)), [pred("a", vr(1)), pred("b", vr(1))]));
  w.run();
  const bucket = [...w.facts.values()].find((b) =>
    [...b.items.keys()].some((k) => k.startsWith("c/")),
  );
  assert.equal(bucket!.origin.key, "0,1,2");
});

test("trusted origins hide facts from untrusted blocks", () => {
  const w = world();
  w.addFact(Origin.of(1), fact("secret", int(1)));
  const trusted = new TrustedOrigins([0, 0xffffffff]);
  assert.equal(w.queryMatch(rule(pred("q"), [pred("secret", vr(1))]), 0xffffffff, trusted), false);
  assert.equal(w.queryMatch(rule(pred("q"), [pred("secret", vr(1))]), 0xffffffff, ALL), true);
});

/* -------------------------------------------------------- expression VM */

const ev = (ops: Op[], vals: [number, Term][] = []) => evaluateExpression(ops, new Map(vals));
const val = (v: Term): Op => ({ kind: "value", value: v });
const bin = (op: number): Op => ({ kind: "binary", op });
const un = (op: number): Op => ({ kind: "unary", op });

test("i64 arithmetic overflows are errors, not wraparound", () => {
  assert.throws(
    () => ev([val(int(9223372036854775807n)), val(int(1)), bin(B.Add)]),
    (e: any) => e instanceof ExecutionError && e.kind === "Overflow",
  );
  assert.deepEqual(ev([val(int(2)), val(int(3)), bin(B.Mul)]), int(6));
  assert.throws(
    () => ev([val(int(1)), val(int(0)), bin(B.Div)]),
    (e: any) => e.kind === "DivideByZero",
  );
});

test("strict equality is a type error across types, lenient equality is false", () => {
  assert.throws(
    () => ev([val(int(1)), val(str("1")), bin(B.Equal)]),
    (e: any) => e.kind === "InvalidType",
  );
  assert.deepEqual(ev([val(int(1)), val(str("1")), bin(B.HeterogeneousEqual)]), {
    t: "bool",
    v: false,
  });
  assert.deepEqual(ev([val({ t: "null" }), val({ t: "null" }), bin(B.Equal)]), {
    t: "bool",
    v: true,
  });
  assert.deepEqual(ev([val({ t: "null" }), val(int(1)), bin(B.HeterogeneousNotEqual)]), {
    t: "bool",
    v: true,
  });
});

test("string length is measured in UTF-8 bytes", () => {
  assert.deepEqual(ev([val(str("héllo")), un(U.Length)]), int(6));
  assert.deepEqual(ev([val(str("abc")), un(U.TypeOf)]), str("string"));
});

test("regex is unanchored and invalid patterns are false", () => {
  assert.deepEqual(ev([val(str("abcd")), val(str("bc")), bin(B.Regex)]), { t: "bool", v: true });
  assert.deepEqual(ev([val(str("abcd")), val(str("[")), bin(B.Regex)]), { t: "bool", v: false });
});

test("closures: lazy and/or short-circuit, any/all iterate", () => {
  const closure = (ops: Op[], params: number[] = []): Op => ({ kind: "closure", params, ops });
  // false && <error> => false, without evaluating the right side
  assert.deepEqual(
    ev([
      val({ t: "bool", v: false }),
      closure([val(int(1)), val(str("x")), bin(B.Equal)]),
      bin(B.LazyAnd),
    ]),
    { t: "bool", v: false },
  );
  // [1,2].any($x -> $x == 2)
  const arr: Term = { t: "array", v: [int(1), int(2)] };
  assert.deepEqual(
    ev([val(arr), closure([val(vr(5)), val(int(2)), bin(B.Equal)], [5]), bin(B.Any)]),
    { t: "bool", v: true },
  );
  assert.deepEqual(
    ev([val(arr), closure([val(vr(5)), val(int(0)), bin(B.GreaterThan)], [5]), bin(B.All)]),
    { t: "bool", v: true },
  );
});

test("shadowing a bound variable with a closure parameter is rejected", () => {
  const closure: Op = {
    kind: "closure",
    params: [1],
    ops: [val(vr(1)), val(int(1)), bin(B.Equal)],
  };
  assert.throws(
    () => ev([val({ t: "array", v: [int(1)] }), closure, bin(B.Any)], [[1, int(1)]]),
    (e: any) => e.kind === "ShadowedVariable",
  );
});

test("set operations", () => {
  const s = (...items: Term[]): Term => ({ t: "set", v: items });
  assert.deepEqual(ev([val(s(int(1), int(2))), val(int(2)), bin(B.Contains)]), {
    t: "bool",
    v: true,
  });
  assert.deepEqual(ev([val(s(int(1), int(2))), val(s(int(2), int(3))), bin(B.Intersection)]), {
    t: "set",
    v: [int(2)],
  });
  assert.deepEqual(ev([val(s(int(1))), val(s(int(2))), bin(B.Union)]), {
    t: "set",
    v: [int(1), int(2)],
  });
});

test("run limits stop runaway rules", () => {
  const w = world();
  w.addFact(O0, fact("n", int(0)));
  const inc: Op[] = [val(vr(1)), val(int(1)), bin(B.Add)];
  // n($x+1) <- n($x) : generates facts forever
  w.addRule(0, ALL, {
    head: pred("n", vr(2)),
    body: [pred("n", vr(1))],
    expressions: [[...inc, val(vr(2)), bin(B.Equal)]],
    scopes: [],
  });
  assert.throws(
    () => w.run({ maxFacts: 50, maxIterations: 1000, maxTimeMs: 5000 }),
    ExecutionError,
  );
});
