import assert from "node:assert";
import fs from "node:fs";
import {
  type AuthorizationResult,
  authorize,
  type FailedCheck,
  loadToken,
} from "../src/authorizer.js";
import type { ExternFn, Term } from "../src/datalog.js";

// the sample suite registers one extern function, named `test`
const externs = new Map<string, ExternFn>([
  [
    "test",
    ((left: Term, right?: Term): Term => {
      if (right === undefined) return left;
      if (left.t === "str" && right.t === "str")
        return { t: "str", v: left.v === right.v ? "equal strings" : "different strings" };
      throw new Error("unsupported operands");
    }) as ExternFn,
  ],
]);

const dir = new URL("../samples/", import.meta.url).pathname;
const samples = JSON.parse(fs.readFileSync(dir + "samples.json", "utf8"));
const rootKey = new Uint8Array(Buffer.from(samples.root_public_key, "hex"));

/** normalize the expected `result` from samples.json into our shape */
function expected(result: any): {
  kind: string;
  policy?: any;
  checks?: FailedCheck[];
  error?: string;
} {
  if ("Ok" in result) return { kind: "ok", policy: result.Ok };
  const err = result.Err;
  if ("Format" in err) return { kind: "format" };
  if ("FailedLogic" in err && "InvalidBlockRule" in err.FailedLogic)
    return {
      kind: "invalidBlockRule",
      policy: err.FailedLogic.InvalidBlockRule[0],
      error: err.FailedLogic.InvalidBlockRule[1],
    };
  if ("Execution" in err)
    return {
      kind: "execution",
      error: typeof err.Execution === "string" ? err.Execution : "Execution",
    };
  if ("FailedLogic" in err) {
    const logic = err.FailedLogic;
    if ("Unauthorized" in logic)
      return {
        kind: "unauthorized",
        policy: logic.Unauthorized.policy,
        checks: normalizeChecks(logic.Unauthorized.checks),
      };
    if ("NoMatchingPolicy" in logic)
      return { kind: "noMatchingPolicy", checks: normalizeChecks(logic.NoMatchingPolicy.checks) };
  }
  return { kind: "other" };
}

function normalizeChecks(checks: any[]): FailedCheck[] {
  return checks.map((c) =>
    "Block" in c
      ? { source: "block" as const, blockId: c.Block.block_id, checkId: c.Block.check_id }
      : { source: "authorizer" as const, checkId: c.Authorizer.check_id },
  );
}

function actualShape(r: AuthorizationResult): {
  kind: string;
  policy?: any;
  checks?: FailedCheck[];
  error?: string;
} {
  if (r.kind === "ok") return { kind: "ok", policy: r.policy };
  if (r.kind === "unauthorized")
    return {
      kind: "unauthorized",
      policy: "allow" in r.policy ? { Allow: r.policy.allow } : { Deny: r.policy.deny },
      checks: r.checks,
    };
  if (r.kind === "noMatchingPolicy") return { kind: "noMatchingPolicy", checks: r.checks };
  if (r.kind === "execution") return { kind: "execution", error: r.error };
  if (r.kind === "invalidBlockRule")
    return { kind: "invalidBlockRule", policy: r.blockId, error: r.rule };
  return { kind: "format" };
}

const results: { name: string; ok: boolean; detail?: string }[] = [];

for (const tc of samples.testcases) {
  for (const [name, validation] of Object.entries<any>(tc.validations)) {
    const label = `${tc.filename} :: ${name || "(default)"}`;
    test(label, () => {
      const raw = new Uint8Array(fs.readFileSync(dir + tc.filename));
      const want = expected(validation.result);

      let got: AuthorizationResult;
      try {
        const token = loadToken(raw, rootKey);
        got = authorize(token, validation.authorizer_code, { externs });
        if (want.kind !== "format" && validation.revocation_ids?.length)
          assert.deepStrictEqual(token.revocationIds, validation.revocation_ids, "revocation ids");
      } catch (e) {
        got = { kind: "format", error: (e as Error).message };
      }

      const have = actualShape(got);
      try {
        assert.equal(have.kind, want.kind, `result kind (got ${JSON.stringify(have)})`);
        if (want.kind === "ok") assert.equal(have.policy, want.policy, "allow policy index");
        if (want.kind === "unauthorized")
          assert.deepStrictEqual(have.policy, want.policy, "matched policy");
        if (want.kind === "execution") assert.equal(have.error, want.error, "execution error");
        if (want.kind === "invalidBlockRule") {
          assert.equal(have.policy, want.policy, "invalid rule block id");
          assert.equal(have.error, want.error, "invalid rule source");
        }
        if (want.checks) assert.deepStrictEqual(have.checks, want.checks, "failed checks");
        results.push({ name: label, ok: true });
      } catch (e) {
        results.push({ name: label, ok: false, detail: (e as Error).message });
        throw e;
      }
    });
  }
}

test("the suite covers every sample and every validation", () => {
  assert.equal(samples.testcases.length, 38, "sample count");
  const validations = samples.testcases.reduce(
    (n: number, t: any) => n + Object.keys(t.validations).length,
    0,
  );
  assert.equal(results.length, validations, "every validation ran");
  assert.ok(
    results.every((r) => r.ok),
    "every validation passed",
  );
});
