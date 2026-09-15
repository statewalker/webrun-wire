import assert from "node:assert";
import { evaluateExpression, type Term } from "../src/datalog.js";
import { Parser, parse } from "../src/parser.js";

const evalExpr = (src: string, vals: Record<string, Term> = {}) => {
  const p = new Parser(src);
  const ops = p.expression();
  const m = new Map<number, Term>();
  for (const [k, v] of Object.entries(vals)) m.set(p.varId(k), v);
  return evaluateExpression(ops, m);
};
const T = (v: boolean): Term => ({ t: "bool", v });

test("parses facts, rules, checks and policies", () => {
  const st = parse(`
    // a comment
    right("file1", "read");
    right($f, "write") <- owner("alice", $f);
    check if resource($0), operation("read"), right($0, "read");
    check all resource($0), $0.starts_with("/folder/");
    reject if resource("file1");
    allow if true;
    deny if false;
  `);
  assert.deepEqual(
    st.map((s) => s.k),
    ["fact", "rule", "check", "check", "check", "policy", "policy"],
  );
  assert.equal((st[2] as any).check.kind, "one");
  assert.equal((st[3] as any).check.kind, "all");
  assert.equal((st[4] as any).check.kind, "reject");
  assert.equal((st[5] as any).kind, "allow");
});

test('multi-query checks separated by "or"', () => {
  const st = parse('check if resource("file1") or resource("file2");');
  assert.equal((st[0] as any).check.queries.length, 2);
});

test("parses every term type", () => {
  const st = parse(
    'f(1, -2, "s", true, false, null, hex:0aff, 2019-02-05T23:00:00Z, {1, 2}, [1, "a"], {"k": 1}, {,}, {});',
  );
  const terms = (st[0] as any).fact.predicate.terms;
  assert.deepEqual(
    terms.map((t: Term) => t.t),
    [
      "int",
      "int",
      "str",
      "bool",
      "bool",
      "null",
      "bytes",
      "date",
      "set",
      "array",
      "map",
      "set",
      "map",
    ],
  );
  assert.equal(terms[1].v, -2n);
  assert.equal(terms[7].v, 1549407600n);
  assert.equal(terms[11].v.length, 0); // {,} empty set
  assert.equal(terms[12].v.length, 0); // {} empty map
});

test("operator precedence", () => {
  assert.deepEqual(evalExpr("1 + 2 * 3 === 7"), T(true));
  assert.deepEqual(evalExpr("(1 + 2) * 3 === 9"), T(true));
  assert.deepEqual(evalExpr("1 < 2 && 3 > 2"), T(true));
  assert.deepEqual(evalExpr("false || true"), T(true));
  assert.deepEqual(evalExpr("!(1 === 2)"), T(true));
  assert.deepEqual(evalExpr("5 & 3 === 1"), T(true));
});

test("strict vs lenient equality operators are distinguished", () => {
  assert.deepEqual(evalExpr('1 == "a"'), T(false));
  assert.deepEqual(evalExpr('1 != "a"'), T(true));
  assert.deepEqual(evalExpr("1 === 1"), T(true));
  assert.deepEqual(evalExpr("1 !== 2"), T(true));
});

test("methods and closures", () => {
  assert.deepEqual(evalExpr('"hello".starts_with("he")'), T(true));
  assert.deepEqual(evalExpr('"hello".length() === 5'), T(true));
  assert.deepEqual(evalExpr("{1, 2}.contains(2)"), T(true));
  assert.deepEqual(evalExpr("[1, 2].any($x -> $x === 2)"), T(true));
  assert.deepEqual(evalExpr("[1, 2].all($x -> $x > 0)"), T(true));
  assert.deepEqual(evalExpr('{"a": 1}.get("a") === 1'), T(true));
  assert.deepEqual(evalExpr("(1/0).try_or(true)"), T(true));
  assert.deepEqual(evalExpr('"abc".type() === "string"'), T(true));
});

test("variables bind by name", () => {
  assert.deepEqual(evalExpr("$x > 1", { x: { t: "int", v: 5n } }), T(true));
});

test("trusting annotations", () => {
  const st = parse(
    "check if query(1, 2) trusting ed25519/acdd6d5b53bfee478bf689f8e012fe7988bf755e3d7c5152947abc149bc20189;",
  );
  const q = (st[0] as any).check.queries[0];
  assert.equal(q.scopes.length, 1);
  assert.equal(q.scopes[0].kind, "publicKey");
  assert.ok(q.scopes[0].key.startsWith("ed25519/acdd"));
  const st2 = parse("check if a($x) trusting authority, previous;");
  assert.deepEqual(
    (st2[0] as any).check.queries[0].scopes.map((s: any) => s.kind),
    ["authority", "previous"],
  );
});

test("predicates and expressions are told apart in a rule body", () => {
  const st = parse('check if resource($0), $0.starts_with("/f"), operation("read");');
  const q = (st[0] as any).check.queries[0];
  assert.equal(q.body.length, 2);
  assert.equal(q.expressions.length, 1);
});

test("rejects variables in facts", () => {
  assert.throws(() => parse("f($x);"), /variables/);
});

test("names and arity follow the reference parser", async () => {
  const { GRAMMAR_CASES } = await import("./grammar-cases.js");
  const wrong: string[] = [];
  for (const c of GRAMMAR_CASES) {
    let accepted = true;
    try {
      parse(`${c.source};`);
    } catch {
      accepted = false;
    }
    if (accepted !== c.accepted)
      wrong.push(`${JSON.stringify(c.source)}: reference ${c.accepted ? "accepts" : "rejects"}`);
  }
  assert.deepStrictEqual(wrong, []);
});

test("a name that begins with a digit does not swallow a number in an expression", () => {
  const [st] = parse("check if n($x), $x < 10, 10a(1);");
  assert.equal(st.k, "check");
  const q = (st as { check: { queries: { body: { name: string }[]; expressions: unknown[] }[] } })
    .check.queries[0];
  assert.deepStrictEqual(
    q.body.map((p) => p.name),
    ["n", "10a"],
  );
  assert.equal(q.expressions.length, 1);
});
