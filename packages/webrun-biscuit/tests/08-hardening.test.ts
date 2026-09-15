import assert from "node:assert";
import fs from "node:fs";
import { authorize, loadToken } from "../src/authorizer.js";
import { fromBase64, toBase64 } from "../src/base64.js";
import { attenuate, buildToken, generateKeypair, sealToken } from "../src/builder.js";
import { Origin, type Term, TrustedOrigins, World } from "../src/datalog.js";
import { decodeBiscuit, encodeBiscuit, ProtoError } from "../src/proto.js";

/** deterministic PRNG so failures are reproducible */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("property: minted tokens survive encode/decode/base64 round-trips", () => {
  const rand = rng(12345);
  const root = generateKeypair();
  for (let i = 0; i < 25; i++) {
    const depth = 1 + Math.floor(rand() * 3);
    let bytes = buildToken(root.secretKey, `user("u${Math.floor(rand() * 1e6)}");`);
    for (let d = 0; d < depth; d++)
      bytes = attenuate(bytes, `check if user("u${Math.floor(rand() * 1e6)}") or true;`);
    if (rand() < 0.5) bytes = sealToken(bytes);

    assert.deepStrictEqual(encodeBiscuit(decodeBiscuit(bytes)), bytes, "proto round-trip");
    assert.deepStrictEqual(fromBase64(toBase64(bytes)), bytes, "base64 round-trip");
    assert.doesNotThrow(() => loadToken(bytes, root.publicKey), "still verifies");
  }
});

test("fuzz: no single-byte mutation of a valid token ever verifies", () => {
  const rand = rng(999);
  const root = generateKeypair();
  const original = attenuate(
    buildToken(root.secretKey, 'right("file1", "read");'),
    'check if operation("read");',
  );

  let accepted = 0;
  for (let i = 0; i < 400; i++) {
    const mutated = original.slice();
    const at = Math.floor(rand() * mutated.length);
    const flip = 1 << Math.floor(rand() * 8);
    if ((mutated[at] ^ flip) === mutated[at]) continue;
    mutated[at] ^= flip;
    if (mutated.every((b, j) => b === original[j])) continue;
    try {
      loadToken(mutated, root.publicKey);
      accepted++;
    } catch {
      /* expected: malformed or bad signature */
    }
  }
  assert.equal(accepted, 0, "a mutated token was accepted");
});

test("fuzz: random bytes are rejected cleanly, never hang or crash", () => {
  const rand = rng(4242);
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rand() * 200);
    const bytes = new Uint8Array(len).map(() => Math.floor(rand() * 256));
    try {
      decodeBiscuit(bytes);
    } catch (e) {
      assert.ok(e instanceof ProtoError || e instanceof Error, "threw a typed error");
      continue;
    }
    // decoding random bytes may occasionally succeed; verification must not
    assert.throws(() => loadToken(bytes, new Uint8Array(32)));
  }
});

test("fuzz: truncating a valid token is always rejected", () => {
  const root = generateKeypair();
  const token = buildToken(root.secretKey, 'user("alice");');
  for (let cut = 1; cut < token.length; cut += 7) {
    assert.throws(() => loadToken(token.subarray(0, cut), root.publicKey), `truncated at ${cut}`);
  }
});

test("indexed joins scale to a few thousand facts", () => {
  const world = new World();
  const origin = Origin.of(0);
  const trusted = new TrustedOrigins([0, 0xffffffff]);
  const int = (v: number): Term => ({ t: "int", v: BigInt(v) });

  const N = 1500;
  for (let i = 0; i < N; i++) {
    world.addFact(origin, { predicate: { name: "a", terms: [int(i)] } });
    world.addFact(origin, { predicate: { name: "b", terms: [int(i)] } });
    world.addFact(origin, { predicate: { name: "noise", terms: [int(i)] } });
  }
  world.addRule(0, trusted, {
    head: { name: "c", terms: [{ t: "var", v: 1 }] },
    body: [
      { name: "a", terms: [{ t: "var", v: 1 }] },
      { name: "b", terms: [{ t: "var", v: 1 }] },
    ],
    expressions: [],
    scopes: [],
  });

  const started = Date.now();
  world.run({ maxFacts: 10_000, maxIterations: 100, maxTimeMs: 30_000 });
  const elapsed = Date.now() - started;

  let derived = 0;
  for (const bucket of world.facts.values())
    for (const k of bucket.items.keys()) if (k.startsWith("c/")) derived++;
  assert.equal(derived, N, "every join produced a fact");
  assert.ok(elapsed < 10_000, `join took ${elapsed}ms`);
});

test("the run limits are enforced", () => {
  const world = new World();
  const trusted = new TrustedOrigins([0, 0xffffffff]);
  for (let i = 0; i < 100; i++)
    world.addFact(Origin.of(0), { predicate: { name: "a", terms: [{ t: "int", v: BigInt(i) }] } });
  world.addRule(0, trusted, {
    head: {
      name: "pair",
      terms: [
        { t: "var", v: 1 },
        { t: "var", v: 2 },
      ],
    },
    body: [
      { name: "a", terms: [{ t: "var", v: 1 }] },
      { name: "a", terms: [{ t: "var", v: 2 }] },
    ],
    expressions: [],
    scopes: [],
  });
  assert.throws(
    () => world.run({ maxFacts: 500, maxIterations: 100, maxTimeMs: 30_000 }),
    /TooManyFacts/,
  );
});

/* The budget holds INSIDE an iteration, not only between iterations. A rule
 * whose join is combinatorial enumerates its whole product in one iteration;
 * checking the limits only afterwards let a token pin a verifier for seconds
 * whatever `maxTimeMs` said (measured: 4.8 s against a 50 ms budget). */

const EXPLOSION = (() => {
  let src = "";
  for (let i = 0; i < 60; i++) src += `s(${i});`;
  return `${src}\np($x, $y) <- s($x), s($y);\nq($x, $y) <- p($x, $z), p($z, $y);\nr($x, $y) <- q($x, $z), q($z, $y);`;
})();

const timed = <T>(run: () => T): [T, number] => {
  const started = performance.now();
  const result = run();
  return [result, performance.now() - started];
};

test("an exploding rule set stops on its budget, inside the iteration", () => {
  const root = generateKeypair();
  const token = loadToken(attenuate(buildToken(root.secretKey, "user(1);"), EXPLOSION), root.publicKey);

  // The fact limit counts DISTINCT facts as they are derived, so it fires as
  // soon as the world would exceed it rather than after the whole product. Only
  // the verdict is asserted: how soon depends on how fast the join enumerates,
  // and the bound a caller relies on is the clock, asserted next.
  const byFacts = authorize(token, "allow if true;", {
    limits: { maxFacts: 5_000, maxIterations: 200, maxTimeMs: 60_000 },
  });
  assert.deepStrictEqual(byFacts, { kind: "execution", error: "TooManyFacts" });

  // The time limit is honoured mid-iteration too.
  const [byTime, timeMs] = timed(() =>
    authorize(token, "allow if true;", {
      limits: { maxFacts: 10_000_000, maxIterations: 200, maxTimeMs: 50 },
    }),
  );
  assert.deepStrictEqual(byTime, { kind: "execution", error: "Timeout" });
  assert.ok(timeMs < 1_000, `a 50 ms budget took ${timeMs.toFixed(0)} ms`);
});

test("an exploding check stops on the time budget, though it derives no facts", () => {
  let facts = "";
  for (let i = 0; i < 200; i++) facts += `s(${i});`;
  // 8 million bindings, none of which is a fact: only the clock can stop it.
  const code = `${facts}\ncheck if s($a), s($b), s($c), $a + $b + $c < 0;\nallow if true;`;
  const [result, ms] = timed(() =>
    authorize(null, code, { limits: { maxFacts: 1_000, maxIterations: 100, maxTimeMs: 50 } }),
  );
  assert.deepStrictEqual(result, { kind: "execution", error: "Timeout" });
  assert.ok(ms < 1_000, `a 50 ms budget took ${ms.toFixed(0)} ms`);
});

test("a query made after the evaluation is not charged against its expired budget", async () => {
  const { evaluate } = await import("../src/authorizer.js");
  // Enough facts that the query walks past the clock's polling interval
  // (every 1024 candidates): with one fact, a leaked deadline is never read.
  let facts = "";
  for (let i = 0; i < 3_000; i++) facts += `role(${i});`;
  const ev = evaluate(null, facts, { limits: { maxFacts: 10_000, maxIterations: 10, maxTimeMs: 1 } });
  assert.equal(ev.result.kind, "noMatchingPolicy");
  const until = Date.now() + 5;
  while (Date.now() < until) {
    /* let the evaluation's 1 ms budget lapse */
  }
  assert.equal(ev.query("x($r) <- role($r)").length, 3_000);
});
