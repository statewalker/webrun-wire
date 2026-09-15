/**
 * `{name}` parameters: values bound as TERMS, never spliced into source text.
 *
 * The reference offers the same thing (`code_with_params` in Rust,
 * `addCodeWithParameters` in the WASM build), and it is the safe way to put an
 * untrusted value into Datalog. The hostile-string cases below are the reason
 * it exists: quoting by hand is an injection seam.
 */
import assert from "node:assert";
import { authorize, loadToken, parseAuthorizer } from "../src/authorizer.js";
import { attenuate, buildToken, generateKeypair } from "../src/builder.js";
import { ParseError } from "../src/parser.js";

const HOSTILE = ['"); role("admin', '\\"); role("admin', "\\", "line\nbreak", "{x}", "$y", ""];

test("a string parameter is one term, whatever it contains", () => {
  for (const value of HOSTILE) {
    const parsed = parseAuthorizer("role({r});", { r: value });
    assert.equal(parsed.facts.length, 1, JSON.stringify(value));
    assert.equal(parsed.rules.length + parsed.checks.length + parsed.policies.length, 0);
    assert.deepStrictEqual(parsed.facts[0].predicate.terms, [{ t: "str", v: value }]);
  }
});

test("every supported value type binds to its term", () => {
  const bytes = new Uint8Array([1, 2, 255]);
  const parsed = parseAuthorizer(
    "v({s}, {n}, {b}, {t}, {z}, {bytes}, {date}, {arr}, {set});",
    {
      s: "x",
      n: -42,
      b: 9007199254740993n,
      t: true,
      z: null,
      bytes,
      date: new Date("2026-09-15T10:00:00.900Z"),
      arr: ["a", 1],
      set: new Set([2, 1]),
    },
  );
  assert.deepStrictEqual(parsed.facts[0].predicate.terms, [
    { t: "str", v: "x" },
    { t: "int", v: -42n },
    { t: "int", v: 9007199254740993n },
    { t: "bool", v: true },
    { t: "null" },
    { t: "bytes", v: bytes },
    { t: "date", v: BigInt(Date.parse("2026-09-15T10:00:00Z") / 1000) },
    { t: "array", v: [{ t: "str", v: "a" }, { t: "int", v: 1n }] },
    { t: "set", v: [{ t: "int", v: 1n }, { t: "int", v: 2n }] },
  ]);
});

test("parameters work inside rules, checks, policies and expressions", () => {
  const parsed = parseAuthorizer(
    "can($u) <- user($u), $u != {banned};\ncheck if time($t), $t < {exp};\nallow if user({who});",
    { banned: "mallory", exp: 100, who: "alice" },
  );
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.checks.length, 1);
  assert.equal(parsed.policies.length, 1);
});

test("an unbound parameter is a parse error, not a silent literal", () => {
  assert.throws(() => parseAuthorizer("role({r});"), ParseError);
  assert.throws(() => parseAuthorizer("role({r});", { other: "x" }), /unbound parameter \{r\}/);
});

test("an unused parameter is a parse error, as in the reference", () => {
  assert.throws(() => parseAuthorizer("role({r});", { r: "a", typo: "b" }), /unused parameter/);
});

test("values without an exact term are refused", () => {
  assert.throws(() => parseAuthorizer("v({n});", { n: 1.5 }), ParseError);
  assert.throws(() => parseAuthorizer("v({n});", { n: 2 ** 60 }), ParseError);
  assert.throws(() => parseAuthorizer("v({n});", { n: 2n ** 63n }), ParseError);
  assert.throws(() => parseAuthorizer("v({n});", { n: undefined as never }), ParseError);
  assert.throws(() => parseAuthorizer("v({n});", { n: new Date(Number.NaN) }), ParseError);
  assert.throws(() => parseAuthorizer("v({n});", { n: {} as never }), ParseError);
});

test("braces that are not a parameter keep their meaning", () => {
  const parsed = parseAuthorizer("v({true}, {,}, {}, {1, 2}, {\"k\": 1});");
  assert.deepStrictEqual(
    parsed.facts[0].predicate.terms.map((t) => t.t),
    ["set", "set", "map", "set", "map"],
  );
});

test("minting, attenuating and authorizing all take parameters", () => {
  const root = generateKeypair();
  const token = buildToken(root.secretKey, "user({u});", { params: { u: '"); admin(true' } });
  const attenuated = attenuate(token, "check if operation({op});", { params: { op: "read" } });
  const loaded = loadToken(attenuated, root.publicKey);

  assert.deepStrictEqual(
    authorize(loaded, "operation({op});\nallow if user({u});", {
      params: { op: "read", u: '"); admin(true' },
    }),
    { kind: "ok", policy: 0 },
  );
  assert.equal(
    authorize(loaded, "operation({op});\nallow if admin(true);", { params: { op: "read" } }).kind,
    "noMatchingPolicy",
  );
});

test("an unbound parameter in authorizer code is a format result, like any parse error", () => {
  const root = generateKeypair();
  const loaded = loadToken(buildToken(root.secretKey, "user(1);"), root.publicKey);
  assert.equal(authorize(loaded, "allow if user({u});").kind, "format");
});
