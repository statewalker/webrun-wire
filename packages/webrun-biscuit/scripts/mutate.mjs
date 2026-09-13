#!/usr/bin/env node
/**
 * Mutation testing.
 *
 * A green suite proves nothing on its own — it may simply be asserting things
 * that cannot fail. This harness injects a known defect into the source, runs
 * the suite, and requires that the suite *notices*. A mutation that survives
 * is a hole in the tests, not a success.
 *
 *   pnpm mutate              # run every mutation
 *   pnpm mutate -- --list    # show them without running
 *   pnpm mutate -- regex     # only mutations whose name matches
 *
 * Each entry replaces `find` with `replace` in `file`. The replacement must
 * match exactly once, so a mutation that no longer applies fails loudly rather
 * than silently passing.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

/** @type {{name: string, file: string, find: string, replace: string, note: string}[]} */
const MUTATIONS = [
  {
    name: "crypto/lowS",
    file: "src/crypto.ts",
    find: '{ format: "der", prehash: true, lowS: false }',
    replace: '{ format: "der", prehash: true }',
    note: "rejects high-S secp256r1 signatures, which the reference accepts",
  },
  {
    name: "crypto/seal-unchecked",
    file: "src/crypto.ts",
    find: '    if (!verifySignature(currentKey, sealPayloadV0(last), token.proof.value))\n      throw new SignatureError("invalid seal signature");',
    replace: "    void last;",
    note: "accepts any seal signature on a sealed token",
  },
  {
    name: "datalog/overflow-wraps",
    file: "src/datalog.ts",
    find: '  if (v < I64_MIN || v > I64_MAX) throw new ExecutionError("Overflow");\n  return { t: "int", v };',
    replace: '  return { t: "int", v: BigInt.asIntN(64, v) };',
    note: "i64 arithmetic wraps instead of failing",
  },
  {
    name: "datalog/check-all-is-any",
    file: "src/datalog.ts",
    find: "        if (!res.v) return false;\n      }\n    }\n    return found;",
    replace:
      "        if (!res.v) return false;\n      }\n      return found;\n    }\n    return found;",
    note: "`check all` stops at the first combination, becoming `check if`",
  },
  {
    name: "datalog/trust-everything",
    file: "src/datalog.ts",
    find: "    for (const id of origin.ids) if (!this.set.has(id)) return false;\n    return true;",
    replace: "    return true;",
    note: "every block is trusted by every rule — attenuation can grant rights",
  },
  {
    name: "datalog/strict-equality-lenient",
    file: "src/datalog.ts",
    find: '      if (!strictEqable) throw new ExecutionError("InvalidType");',
    replace: "      if (!strictEqable) return bool(false);",
    note: "`===` across types returns false instead of raising a type error",
  },
  {
    name: "authorizer/deny-is-allow",
    file: "src/authorizer.ts",
    find: '          policyResult = policy.kind === "allow" ? { allow: i } : { deny: i };',
    replace: "          policyResult = { allow: i };",
    note: "a matching deny policy authorizes the request",
  },
  {
    name: "authorizer/failed-checks-ignored",
    file: "src/authorizer.ts",
    find: '        : "allow" in policyResult && errors.length === 0',
    replace: '        : "allow" in policyResult',
    note: "a matching allow policy wins even when checks failed",
  },
  {
    name: "version/no-bounds",
    file: "src/version.ts",
    find: "  if (version < MIN_SCHEMA_VERSION || version > MAX_SCHEMA_VERSION)",
    replace: "  if (false)",
    note: "blocks declaring any Datalog version are accepted, including v2",
  },
  {
    name: "proto/lenient-required",
    file: "src/proto.ts",
    find: "  if (v === undefined) throw new ProtoError(`missing required field ${name}`);\n  return v;",
    replace: "  return v as T;",
    note: "missing required protobuf fields decode as undefined",
  },
];

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith("-"));
const selected = MUTATIONS.filter((m) => !filter || m.name.includes(filter));

if (args.includes("--list")) {
  for (const m of selected) console.log(`${m.name.padEnd(32)} ${m.note}`);
  process.exit(0);
}

// The main suite only. The cross-reference suite is deliberately excluded: it
// drives the reference implementation, whose spurious `RunLimit` timeouts would
// show up here as a mutation "caught" by a flake rather than by an assertion.
const suites = [["unit + conformance", ["vitest", "run", "--reporter=dot"]]];

let survived = 0;
for (const mutation of selected) {
  const file = path.join(root, mutation.file);
  const original = fs.readFileSync(file, "utf8");
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.log(
      `✗ ${mutation.name}: pattern matched ${occurrences} times, expected 1 — the mutation is stale`,
    );
    survived++;
    continue;
  }

  fs.writeFileSync(file, original.replace(mutation.find, mutation.replace));
  let caught = false;
  try {
    for (const [, command] of suites) {
      execFileSync("npx", command, { cwd: root, stdio: "pipe" });
    }
  } catch {
    caught = true;
  } finally {
    fs.writeFileSync(file, original);
  }

  if (caught) {
    console.log(`✓ ${mutation.name.padEnd(32)} caught — ${mutation.note}`);
  } else {
    console.log(`✗ ${mutation.name.padEnd(32)} SURVIVED — ${mutation.note}`);
    survived++;
  }
}

console.log(`\n${selected.length - survived}/${selected.length} mutations caught`);
process.exit(survived === 0 ? 0 : 1);
