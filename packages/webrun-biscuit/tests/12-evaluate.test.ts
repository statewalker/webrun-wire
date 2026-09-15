/**
 * `evaluate`: one authorizer run, then as many queries against its world as
 * the caller wants — the reference's `Authorizer::query`.
 */
import assert from "node:assert";
import { authorizeDetailed, evaluate, loadToken } from "../src/authorizer.js";
import { attenuate, buildToken, generateKeypair } from "../src/builder.js";
import { ExecutionError } from "../src/datalog.js";

function token(authority: string, ...blocks: string[]) {
  const root = generateKeypair();
  let bytes = buildToken(root.secretKey, authority);
  for (const b of blocks) bytes = attenuate(bytes, b);
  return loadToken(bytes, root.publicKey);
}

test("a query reads facts from the authority block and the authorizer", () => {
  const t = token('subject("alice");\nrole("reader");\nrole("writer");');
  const ev = evaluate(t, 'mesh("m1");\nallow if true;');
  assert.deepStrictEqual(ev.result, { kind: "ok", policy: 0 });
  assert.deepStrictEqual(ev.query("x($s) <- subject($s)"), [
    { name: "x", terms: [{ t: "str", v: "alice" }] },
  ]);
  assert.deepStrictEqual(
    ev.query("x($r) <- role($r)").map((f) => f.terms[0]),
    [
      { t: "str", v: "reader" },
      { t: "str", v: "writer" },
    ],
  );
  assert.deepStrictEqual(ev.query("x($m) <- mesh($m)").length, 1);
});

test("a query sees derived facts, and nothing a later block asserted", () => {
  const t = token('role("member");', 'role("admin");\nsubject("mallory");');
  const ev = evaluate(t, 'capability("read") <- role("member");\ncapability("root") <- role("admin");');
  assert.deepStrictEqual(ev.query("x($c) <- capability($c)"), [
    { name: "x", terms: [{ t: "str", v: "read" }] },
  ]);
  assert.deepStrictEqual(ev.query("x($s) <- subject($s)"), []);
});

test("a query returns each fact once", () => {
  const ev = evaluate(null, 'a(1);\nb(1);\nx(1) <- a(1);\nx(1) <- b(1);');
  assert.deepStrictEqual(ev.query("y($v) <- x($v)"), [{ name: "y", terms: [{ t: "int", v: 1n }] }]);
});

test("queries take parameters", () => {
  const ev = evaluate(null, 'grant("alice", "read");\ngrant("bob", "write");');
  assert.deepStrictEqual(
    ev.query("x($r) <- grant({who}, $r)", { params: { who: "bob" } }).map((f) => f.terms),
    [[{ t: "str", v: "write" }]],
  );
});

test("a query must be exactly one rule", () => {
  const ev = evaluate(null, "a(1);");
  assert.throws(() => ev.query("a(1)"), /exactly one rule/);
  assert.throws(() => ev.query("x($a) <- a($a); y($a) <- a($a)"), /exactly one rule/);
});

test("no token: the authorizer alone", () => {
  const ev = evaluate(null, 'role("member");\ncapability("read") <- role("member");\nallow if capability("read");');
  assert.deepStrictEqual(ev.result, { kind: "ok", policy: 0 });
  const denied = evaluate(null, "check if nope(true);\nallow if true;");
  assert.equal(denied.result.kind, "unauthorized");
  const none = evaluate(null, "a(1);");
  assert.deepStrictEqual(none.result, { kind: "noMatchingPolicy", checks: [] });
});

test("failed checks carry their rule text, as printed", () => {
  const t = token("check if bound($k), connection_peer($k);\ncheck if right($r), $r.starts_with(\"/x\");");
  const ev = evaluate(t, 'check if self_peer($p);\nbound("a");\nallow if true;');
  assert.deepStrictEqual(ev.result, {
    kind: "unauthorized",
    policy: { allow: 0 },
    checks: [
      { source: "authorizer", checkId: 0, rule: "check if self_peer($p)" },
      { source: "block", blockId: 0, checkId: 0, rule: "check if bound($k), connection_peer($k)" },
      { source: "block", blockId: 0, checkId: 1, rule: 'check if right($r), $r.starts_with("/x")' },
    ],
  });
});

test("the snapshot is the one authorizeDetailed returns", () => {
  const t = token('user("alice");', 'check if operation("read");');
  const code = 'operation("read");\nallow if user("alice");';
  assert.deepStrictEqual(evaluate(t, code).snapshot(), authorizeDetailed(t, code).world);
});

test("after an execution error the result says so and queries refuse", () => {
  const items = Array.from({ length: 10 }, (_, i) => `item(${i});`).join("\n");
  const ev = evaluate(null, `${items}\npair($a, $b) <- item($a), item($b);`, {
    limits: { maxFacts: 50, maxIterations: 1000, maxTimeMs: 1000 },
  });
  assert.deepStrictEqual(ev.result, { kind: "execution", error: "TooManyFacts" });
  assert.throws(() => ev.query("x($v) <- item($v)"), ExecutionError);
});

test("a format error in authorizer code is a result, and queries refuse", () => {
  const ev = evaluate(null, "allow if");
  assert.equal(ev.result.kind, "format");
  assert.throws(() => ev.query("x($v) <- n($v)"), /format/);
});
