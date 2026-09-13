/**
 * Datalog block versioning.
 *
 * Every block declares the Datalog version it was generated at. An
 * implementation must reject versions outside the supported window, and must
 * reject a block that uses a feature newer than the version it declares —
 * otherwise a token could smuggle newer semantics past an older verifier.
 *
 * Mirrors `get_schema_version` / `check_compatibility` in the reference
 * implementation (biscuit-auth `src/datalog/mod.rs`).
 */
import {
  BinaryOp as B,
  type Check,
  type Fact,
  type Op,
  type Predicate,
  type Rule,
  type Scope,
  type Term,
  UnaryOp as U,
} from "./datalog.js";
import type { CheckMsg } from "./proto.js";

export const MIN_SCHEMA_VERSION = 3;
export const MAX_SCHEMA_VERSION = 6;
export const DATALOG_3_1 = 4;
export const DATALOG_3_2 = 5;
export const DATALOG_3_3 = 6;

export class VersionError extends Error {}

export interface BlockContentLike {
  facts: Fact[];
  rules: Rule[];
  checks: Check[];
  scopes: Scope[];
}

/* ----------------------------------------------------- feature detection */

/** null, or a set containing null — arrays and maps are deliberately not
 *  flagged here, matching the reference implementation */
const isV33Term = (t: Term): boolean =>
  t.t === "null" || (t.t === "set" && t.v.some((x) => x.t === "null"));

const hasV33Predicate = (p: Predicate): boolean => p.terms.some(isV33Term);

const hasV31Op = (expressions: Op[][]): boolean =>
  expressions.some((ops) =>
    ops.some(
      (op) =>
        op.kind === "binary" &&
        (op.op === B.BitwiseAnd ||
          op.op === B.BitwiseOr ||
          op.op === B.BitwiseXor ||
          op.op === B.NotEqual),
    ),
  );

const hasV33Op = (expressions: Op[][]): boolean =>
  expressions.some((ops) =>
    ops.some((op) => {
      if (op.kind === "value") return isV33Term(op.value);
      if (op.kind === "closure") return true;
      if (op.kind === "unary") return op.op === U.TypeOf || op.op === U.Ffi;
      return (
        op.op === B.HeterogeneousEqual ||
        op.op === B.HeterogeneousNotEqual ||
        op.op === B.LazyAnd ||
        op.op === B.LazyOr ||
        op.op === B.All ||
        op.op === B.Any ||
        op.op === B.Ffi
      );
    }),
  );

export interface BlockFeatures {
  scopes: boolean;
  v31: boolean;
  checkAll: boolean;
  v33: boolean;
}

export function blockFeatures(c: BlockContentLike): BlockFeatures {
  const queries = c.checks.flatMap((ch) => ch.queries);

  const scopes =
    c.scopes.length > 0 ||
    c.rules.some((r) => r.scopes.length > 0) ||
    queries.some((q) => q.scopes.length > 0);

  const checkAll = c.checks.some((ch) => ch.kind === "all");
  let v33 = c.checks.some((ch) => ch.kind === "reject");

  const v31 =
    c.rules.some((r) => hasV31Op(r.expressions)) || queries.some((q) => hasV31Op(q.expressions));

  if (!v33)
    v33 =
      c.rules.some(
        (r) => hasV33Predicate(r.head) || r.body.some(hasV33Predicate) || hasV33Op(r.expressions),
      ) || queries.some((q) => q.body.some(hasV33Predicate) || hasV33Op(q.expressions));
  if (!v33) v33 = c.facts.some((f) => hasV33Predicate(f.predicate));

  return { scopes, v31, checkAll, v33 };
}

/** the lowest version that can legally carry this block's content */
export function requiredVersion(c: BlockContentLike): number {
  const f = blockFeatures(c);
  if (f.v33) return DATALOG_3_3;
  if (f.scopes || f.v31 || f.checkAll) return DATALOG_3_1;
  return MIN_SCHEMA_VERSION;
}

/* -------------------------------------------------------------- validation */

/**
 * Rejects a block whose declared version is out of range, or which uses a
 * feature newer than that version. `rawChecks` is needed because the gate on
 * check kinds distinguishes an absent kind from an explicit `One`.
 */
export function validateBlockVersion(
  declared: number | undefined,
  rawChecks: CheckMsg[],
  hasExternalKey: boolean,
  content: BlockContentLike,
): void {
  const version = declared ?? 0;
  if (version < MIN_SCHEMA_VERSION || version > MAX_SCHEMA_VERSION)
    throw new VersionError(
      `unsupported datalog version ${version}: supported versions are ${MIN_SCHEMA_VERSION} to ${MAX_SCHEMA_VERSION}`,
    );

  if (version < MAX_SCHEMA_VERSION) {
    for (const c of rawChecks) {
      if (version < DATALOG_3_1 && c.kind !== undefined)
        throw new VersionError("check kinds are only supported on datalog v3.1+ blocks");
      if (version < DATALOG_3_3 && c.kind === 2)
        throw new VersionError("reject if is only supported in datalog v3.3+");
    }
  }

  if (version < DATALOG_3_2 && hasExternalKey)
    throw new VersionError("third-party blocks are only supported in datalog v3.2+");

  const f = blockFeatures(content);
  if (version < DATALOG_3_1) {
    if (f.scopes) throw new VersionError("scopes are only supported in datalog v3.1+");
    if (f.v31)
      throw new VersionError("bitwise operators and != are only supported in datalog v3.1+");
    if (f.checkAll) throw new VersionError("check all is only supported in datalog v3.1+");
  } else if (version < DATALOG_3_3 && f.v33) {
    throw new VersionError("maps, arrays, null, closures are only supported in datalog v3.3+");
  }
}
