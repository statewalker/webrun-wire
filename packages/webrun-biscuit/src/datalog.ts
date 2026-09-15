/**
 * Biscuit Datalog: term model, fact/rule evaluation with origin tracking, and
 * the stack-based expression virtual machine.
 */

export const AUTHORIZER = 0xffffffff; // block id of the authorizer (usize::MAX in Rust)

/* -------------------------------------------------------------------- terms */

export type MapKey = { t: "int"; v: bigint } | { t: "str"; v: string };

export type Term =
  | { t: "var"; v: number }
  | { t: "int"; v: bigint }
  | { t: "str"; v: string }
  | { t: "date"; v: bigint }
  | { t: "bytes"; v: Uint8Array }
  | { t: "bool"; v: boolean }
  | { t: "set"; v: Term[] }
  | { t: "null" }
  | { t: "array"; v: Term[] }
  | { t: "map"; v: [MapKey, Term][] };

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Canonical string key: JS Map/Set are reference-keyed, so every structural
 *  comparison and every de-duplication in the engine goes through this. */
export function termKey(t: Term): string {
  switch (t.t) {
    case "var":
      return `v${t.v}`;
    case "int":
      return `i${t.v}`;
    case "str":
      return `s${t.v.length}:${t.v}`;
    case "date":
      return `d${t.v}`;
    case "bytes":
      return `b${hex(t.v)}`;
    case "bool":
      return t.v ? "T" : "F";
    case "null":
      return "N";
    case "set":
      return `S[${t.v.map(termKey).sort().join(",")}]`;
    case "array":
      return `A[${t.v.map(termKey).join(",")}]`;
    case "map":
      return `M[${t.v
        .map(([k, v]) => `${mapKeyKey(k)}=>${termKey(v)}`)
        .sort()
        .join(",")}]`;
  }
}

export const mapKeyKey = (k: MapKey): string =>
  k.t === "int" ? `i${k.v}` : `s${k.v.length}:${k.v}`;
export const termEq = (a: Term, b: Term): boolean => termKey(a) === termKey(b);

/** de-duplicated, deterministically ordered set contents */
export function normalizeSet(items: Term[]): Term[] {
  const seen = new Map<string, Term>();
  for (const i of items) seen.set(termKey(i), i);
  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((e) => e[1]);
}

export interface Predicate {
  name: string;
  terms: Term[];
}
export interface Fact {
  predicate: Predicate;
}
export type Op =
  | { kind: "value"; value: Term }
  | { kind: "unary"; op: number; ffi?: string }
  | { kind: "binary"; op: number; ffi?: string }
  | { kind: "closure"; params: number[]; ops: Op[] };

export type Scope =
  | { kind: "authority" }
  | { kind: "previous" }
  | { kind: "publicKey"; key: string };

export interface Rule {
  head: Predicate;
  body: Predicate[];
  expressions: Op[][];
  scopes: Scope[];
}
export type CheckKind = "one" | "all" | "reject";
export interface Check {
  queries: Rule[];
  kind: CheckKind;
}

export const factKey = (f: Fact): string =>
  `${f.predicate.name}/${f.predicate.terms.length}(${f.predicate.terms.map(termKey).join(",")})`;

/* ------------------------------------------------------------------ origins */

export class Origin {
  constructor(readonly ids: number[] = []) {}
  static of(...ids: number[]): Origin {
    return new Origin([...new Set(ids)].sort((a, b) => a - b));
  }
  union(other: Origin): Origin {
    return Origin.of(...this.ids, ...other.ids);
  }
  with(id: number): Origin {
    return Origin.of(...this.ids, id);
  }
  get key(): string {
    return this.ids.join(",");
  }
}

export class TrustedOrigins {
  private readonly set: Set<number>;
  constructor(ids: Iterable<number>) {
    this.set = new Set(ids);
  }
  static default(): TrustedOrigins {
    return new TrustedOrigins([AUTHORIZER, 0]);
  }
  /** the trusted set is a superset of the fact's origin */
  contains(origin: Origin): boolean {
    for (const id of origin.ids) if (!this.set.has(id)) return false;
    return true;
  }
  get key(): string {
    return [...this.set].sort((a, b) => a - b).join(",");
  }
  /** the trusted block ids, for deriving a new set from this one */
  ids(): Iterable<number> {
    return this.set;
  }
}

export function trustedOriginsFromScopes(
  ruleScopes: Scope[],
  defaults: TrustedOrigins,
  currentBlock: number,
  publicKeyToBlockIds: Map<string, number[]>,
): TrustedOrigins {
  if (ruleScopes.length === 0) {
    const ids = new Set<number>(defaults.ids());
    ids.add(currentBlock);
    ids.add(AUTHORIZER);
    return new TrustedOrigins(ids);
  }
  const ids = new Set<number>([AUTHORIZER, currentBlock]);
  for (const scope of ruleScopes) {
    if (scope.kind === "authority") ids.add(0);
    else if (scope.kind === "previous") {
      if (currentBlock !== AUTHORIZER) for (let i = 0; i <= currentBlock; i++) ids.add(i);
    } else for (const id of publicKeyToBlockIds.get(scope.key) ?? []) ids.add(id);
  }
  return new TrustedOrigins(ids);
}

/* ------------------------------------------------------------------- errors */

export type ExecutionErrorKind =
  | "Overflow"
  | "DivideByZero"
  | "InvalidType"
  | "UnknownVariable"
  | "ShadowedVariable"
  | "InvalidStack"
  | "UndefinedExtern"
  | "TooManyFacts"
  | "TooManyIterations"
  | "Timeout";

export class ExecutionError extends Error {
  constructor(
    readonly kind: ExecutionErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
  }
}

/* --------------------------------------------------------- expression VM */

const U = { Negate: 0, Parens: 1, Length: 2, TypeOf: 3, Ffi: 4 };
const B = {
  LessThan: 0,
  GreaterThan: 1,
  LessOrEqual: 2,
  GreaterOrEqual: 3,
  Equal: 4,
  Contains: 5,
  Prefix: 6,
  Suffix: 7,
  Regex: 8,
  Add: 9,
  Sub: 10,
  Mul: 11,
  Div: 12,
  And: 13,
  Or: 14,
  Intersection: 15,
  Union: 16,
  BitwiseAnd: 17,
  BitwiseOr: 18,
  BitwiseXor: 19,
  NotEqual: 20,
  HeterogeneousEqual: 21,
  HeterogeneousNotEqual: 22,
  LazyAnd: 23,
  LazyOr: 24,
  All: 25,
  Any: 26,
  Get: 27,
  Ffi: 28,
  TryOr: 29,
};
export const BinaryOp = B;
export const UnaryOp = U;

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
function checkedI64(v: bigint): Term {
  if (v < I64_MIN || v > I64_MAX) throw new ExecutionError("Overflow");
  return { t: "int", v };
}

const utf8len = (s: string): number => new TextEncoder().encode(s).length;

export type ExternFn = (left: Term, right?: Term) => Term;

type Bindings = Map<number, Term>;

function typeName(t: Term): string {
  switch (t.t) {
    case "int":
      return "integer";
    case "str":
      return "string";
    case "date":
      return "date";
    case "bytes":
      return "bytes";
    case "bool":
      return "bool";
    case "set":
      return "set";
    case "null":
      return "null";
    case "array":
      return "array";
    case "map":
      return "map";
    default:
      throw new ExecutionError("InvalidType");
  }
}

function unary(op: number, ffi: string | undefined, v: Term, externs: Map<string, ExternFn>): Term {
  switch (op) {
    case U.Negate:
      if (v.t !== "bool") throw new ExecutionError("InvalidType");
      return { t: "bool", v: !v.v };
    case U.Parens:
      return v;
    case U.Length:
      if (v.t === "str") return { t: "int", v: BigInt(utf8len(v.v)) };
      if (v.t === "bytes") return { t: "int", v: BigInt(v.v.length) };
      if (v.t === "set" || v.t === "array" || v.t === "map")
        return { t: "int", v: BigInt(v.v.length) };
      throw new ExecutionError("InvalidType");
    case U.TypeOf:
      return { t: "str", v: typeName(v) };
    case U.Ffi: {
      const f = externs.get(ffi!);
      if (!f) throw new ExecutionError("UndefinedExtern", ffi);
      return f(v);
    }
    default:
      throw new ExecutionError("InvalidType");
  }
}

function setContains(set: Term[], value: Term): boolean {
  const k = termKey(value);
  return set.some((t) => termKey(t) === k);
}

function binary(
  op: number,
  ffi: string | undefined,
  l: Term,
  r: Term,
  externs: Map<string, ExternFn>,
): Term {
  const bool = (v: boolean): Term => ({ t: "bool", v });
  const strictEqable =
    (l.t === r.t && l.t !== "var") ||
    (l.t === "set" && r.t === "set") ||
    (l.t === "map" && r.t === "map");

  switch (op) {
    case B.LessThan:
    case B.GreaterThan:
    case B.LessOrEqual:
    case B.GreaterOrEqual: {
      if (!((l.t === "int" && r.t === "int") || (l.t === "date" && r.t === "date")))
        throw new ExecutionError("InvalidType");
      const a = l.v as bigint;
      const b = r.v as bigint;
      return bool(
        op === B.LessThan
          ? a < b
          : op === B.GreaterThan
            ? a > b
            : op === B.LessOrEqual
              ? a <= b
              : a >= b,
      );
    }
    case B.Equal:
    case B.NotEqual: {
      if (!strictEqable) throw new ExecutionError("InvalidType");
      const eq = termEq(l, r);
      return bool(op === B.Equal ? eq : !eq);
    }
    case B.HeterogeneousEqual:
      return bool(l.t === r.t && termEq(l, r));
    case B.HeterogeneousNotEqual:
      return bool(!(l.t === r.t && termEq(l, r)));
    case B.Add:
      if (l.t === "int" && r.t === "int") return checkedI64(l.v + r.v);
      if (l.t === "str" && r.t === "str") return { t: "str", v: l.v + r.v };
      throw new ExecutionError("InvalidType");
    case B.Sub:
      if (l.t !== "int" || r.t !== "int") throw new ExecutionError("InvalidType");
      return checkedI64(l.v - r.v);
    case B.Mul:
      if (l.t !== "int" || r.t !== "int") throw new ExecutionError("InvalidType");
      return checkedI64(l.v * r.v);
    case B.Div:
      if (l.t !== "int" || r.t !== "int") throw new ExecutionError("InvalidType");
      if (r.v === 0n) throw new ExecutionError("DivideByZero");
      return checkedI64(l.v / r.v);
    case B.BitwiseAnd:
      if (l.t !== "int" || r.t !== "int") throw new ExecutionError("InvalidType");
      return { t: "int", v: BigInt.asIntN(64, l.v & r.v) };
    case B.BitwiseOr:
      if (l.t !== "int" || r.t !== "int") throw new ExecutionError("InvalidType");
      return { t: "int", v: BigInt.asIntN(64, l.v | r.v) };
    case B.BitwiseXor:
      if (l.t !== "int" || r.t !== "int") throw new ExecutionError("InvalidType");
      return { t: "int", v: BigInt.asIntN(64, l.v ^ r.v) };
    case B.And:
      if (l.t !== "bool" || r.t !== "bool") throw new ExecutionError("InvalidType");
      return bool(l.v && r.v);
    case B.Or:
      if (l.t !== "bool" || r.t !== "bool") throw new ExecutionError("InvalidType");
      return bool(l.v || r.v);
    case B.Prefix:
      if (l.t === "str" && r.t === "str") return bool(l.v.startsWith(r.v));
      if (l.t === "array" && r.t === "array")
        return bool(r.v.every((x, i) => i < l.v.length && termEq(l.v[i], x)));
      throw new ExecutionError("InvalidType");
    case B.Suffix:
      if (l.t === "str" && r.t === "str") return bool(l.v.endsWith(r.v));
      if (l.t === "array" && r.t === "array") {
        const off = l.v.length - r.v.length;
        return bool(off >= 0 && r.v.every((x, i) => termEq(l.v[off + i], x)));
      }
      throw new ExecutionError("InvalidType");
    case B.Regex: {
      if (l.t !== "str" || r.t !== "str") throw new ExecutionError("InvalidType");
      try {
        return bool(new RegExp(r.v).test(l.v)); // unanchored, like Rust's is_match
      } catch {
        return bool(false); // invalid pattern is false, not an error
      }
    }
    case B.Contains:
      if (l.t === "str" && r.t === "str") return bool(l.v.includes(r.v));
      if (l.t === "set" && r.t === "set") return bool(r.v.every((x) => setContains(l.v, x)));
      if (l.t === "set") return bool(setContains(l.v, r));
      if (l.t === "array") return bool(setContains(l.v, r));
      if (l.t === "map")
        return bool(
          l.v.some(([k]) =>
            r.t === "int"
              ? k.t === "int" && k.v === r.v
              : r.t === "str" && k.t === "str" && k.v === r.v,
          ),
        );
      throw new ExecutionError("InvalidType");
    case B.Intersection: {
      if (l.t !== "set" || r.t !== "set") throw new ExecutionError("InvalidType");
      return { t: "set", v: normalizeSet(l.v.filter((x) => setContains(r.v, x))) };
    }
    case B.Union: {
      if (l.t !== "set" || r.t !== "set") throw new ExecutionError("InvalidType");
      return { t: "set", v: normalizeSet([...l.v, ...r.v]) };
    }
    case B.Get:
      if (l.t === "array" && r.t === "int") {
        const i = r.v < 0n || r.v >= BigInt(l.v.length) ? -1 : Number(r.v);
        return i < 0 ? { t: "null" } : l.v[i];
      }
      if (l.t === "map" && (r.t === "int" || r.t === "str")) {
        const found = l.v.find(([k]) =>
          r.t === "int" ? k.t === "int" && k.v === r.v : k.t === "str" && k.v === r.v,
        );
        return found ? found[1] : { t: "null" };
      }
      throw new ExecutionError("InvalidType");
    case B.Ffi: {
      const f = externs.get(ffi!);
      if (!f) throw new ExecutionError("UndefinedExtern", ffi);
      return f(l, r);
    }
    default:
      throw new ExecutionError("InvalidType");
  }
}

type StackElem = { s: "term"; v: Term } | { s: "closure"; params: number[]; ops: Op[] };

export function evaluateExpression(
  ops: Op[],
  values: Bindings,
  externs: Map<string, ExternFn> = new Map(),
): Term {
  const stack: StackElem[] = [];
  for (const op of ops) {
    switch (op.kind) {
      case "value":
        if (op.value.t === "var") {
          const bound = values.get(op.value.v);
          if (bound === undefined) throw new ExecutionError("UnknownVariable", String(op.value.v));
          stack.push({ s: "term", v: bound });
        } else stack.push({ s: "term", v: op.value });
        break;
      case "unary": {
        const a = stack.pop();
        if (!a || a.s !== "term") throw new ExecutionError("InvalidStack");
        stack.push({ s: "term", v: unary(op.op, op.ffi, a.v, externs) });
        break;
      }
      case "closure":
        stack.push({ s: "closure", params: op.params, ops: op.ops });
        break;
      case "binary": {
        const right = stack.pop();
        const left = stack.pop();
        if (!right || !left) throw new ExecutionError("InvalidStack");
        if (right.s === "term" && left.s === "term") {
          stack.push({ s: "term", v: binary(op.op, op.ffi, left.v, right.v, externs) });
        } else {
          const closure = right.s === "closure" ? right : left.s === "closure" ? left : null;
          const term = right.s === "term" ? right : left.s === "term" ? left : null;
          if (!closure || !term) throw new ExecutionError("InvalidStack");
          for (const p of closure.params)
            if (values.has(p)) throw new ExecutionError("ShadowedVariable", String(p));
          stack.push({
            s: "term",
            v: evaluateWithClosure(op.op, term.v, closure.ops, closure.params, values, externs),
          });
        }
        break;
      }
    }
  }
  if (stack.length !== 1) throw new ExecutionError("InvalidStack");
  const top = stack[0];
  if (top.s !== "term") throw new ExecutionError("InvalidStack");
  return top.v;
}

function evaluateWithClosure(
  op: number,
  left: Term,
  ops: Op[],
  params: number[],
  values: Bindings,
  externs: Map<string, ExternFn>,
): Term {
  if (op === B.TryOr && params.length === 0) {
    try {
      return evaluateExpression(ops, values, externs);
    } catch {
      return left;
    }
  }
  if ((op === B.LazyOr || op === B.LazyAnd) && params.length === 0) {
    if (left.t !== "bool") throw new ExecutionError("InvalidType");
    if (op === B.LazyOr && left.v) return { t: "bool", v: true };
    if (op === B.LazyAnd && !left.v) return { t: "bool", v: false };
    return evaluateExpression(ops, values, externs);
  }
  if ((op === B.All || op === B.Any) && params.length === 1) {
    const param = params[0];
    let items: Term[];
    if (left.t === "set" || left.t === "array") items = left.v;
    else if (left.t === "map")
      items = left.v.map(
        ([k, v]): Term => ({
          t: "array",
          v: [k.t === "int" ? { t: "int", v: k.v } : { t: "str", v: k.v }, v],
        }),
      );
    else throw new ExecutionError("InvalidType");

    const wanted = op === B.All;
    for (const item of items) {
      const scoped = new Map(values);
      scoped.set(param, item);
      const res = evaluateExpression(ops, scoped, externs);
      if (res.t !== "bool") throw new ExecutionError("InvalidType");
      if (res.v !== wanted) return { t: "bool", v: !wanted };
    }
    return { t: "bool", v: wanted };
  }
  throw new ExecutionError("InvalidType");
}

/* -------------------------------------------------------------------- world */

export interface RunLimits {
  maxFacts: number;
  maxIterations: number;
  maxTimeMs: number;
}
/**
 * Note the divergence: the reference defaults `max_time` to **1 millisecond**,
 * which is unreachably tight for a cold JS engine and would make ordinary
 * tokens fail non-deterministically. 1 second is generous by comparison, so a
 * caller exposed to untrusted tokens should lower it deliberately rather than
 * rely on this default as a denial-of-service bound.
 */
export const DEFAULT_LIMITS: RunLimits = { maxFacts: 1000, maxIterations: 100, maxTimeMs: 1000 };

function matchPredicate(rule: Predicate, fact: Predicate): boolean {
  if (rule.name !== fact.name || rule.terms.length !== fact.terms.length) return false;
  for (let i = 0; i < rule.terms.length; i++) {
    const rt = rule.terms[i];
    const ft = fact.terms[i];
    if (ft.t === "var") return false; // facts never contain variables
    if (rt.t === "var") continue;
    if (rt.t !== ft.t || !termEq(rt, ft)) return false;
  }
  return true;
}

function variablesOf(rule: Rule): Set<number> {
  const out = new Set<number>();
  for (const p of rule.body) for (const t of p.terms) if (t.t === "var") out.add(t.v);
  return out;
}

type OriginFact = [Origin, Fact];
/** facts grouped by `name/arity`, so a join never scans unrelated predicates */
type FactIndex = Map<string, OriginFact[]>;

/** backtracking join over the rule body, mirroring Rust's CombineIt */
function* combine(
  predicates: Predicate[],
  facts: FactIndex,
  bindings: Bindings,
  variables: Set<number>,
  /** called once per candidate fact: the join is where a budget has to bite */
  tick: () => void,
): Generator<[Origin, Bindings]> {
  if (predicates.length === 0) {
    for (const v of variables) if (!bindings.has(v)) return;
    yield [Origin.of(), new Map(bindings)];
    return;
  }
  const [head, ...rest] = predicates;
  for (const [origin, fact] of facts.get(`${head.name}/${head.terms.length}`) ?? []) {
    tick();
    if (!matchPredicate(head, fact.predicate)) continue;
    const next = new Map(bindings);
    let ok = true;
    for (let i = 0; i < head.terms.length; i++) {
      const rt = head.terms[i];
      if (rt.t !== "var") continue;
      const existing = next.get(rt.v);
      if (existing === undefined) next.set(rt.v, fact.predicate.terms[i]);
      else if (!termEq(existing, fact.predicate.terms[i])) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const [subOrigin, result] of combine(rest, facts, next, variables, tick))
      yield [subOrigin.union(origin), result];
  }
}

export class World {
  /** facts indexed by origin key */
  readonly facts = new Map<string, { origin: Origin; items: Map<string, Fact> }>();
  readonly rules: { origin: number; trusted: TrustedOrigins; rule: Rule }[] = [];
  externs = new Map<string, ExternFn>();
  iterations = 0;
  private generation = 0;
  private indexCache = new Map<string, { generation: number; index: FactIndex }>();
  /** wall-clock budget of the evaluation in progress; Infinity outside one */
  private deadline = Number.POSITIVE_INFINITY;
  private steps = 0;

  /**
   * The time limit, enforced where the work is. Checking only between
   * iterations let one combinatorial rule — or one check that derives nothing —
   * run for seconds whatever `maxTimeMs` said. Polled every 1024 candidate
   * facts, so the clock costs nothing measurable.
   */
  private readonly tick = (): void => {
    if ((++this.steps & 1023) === 0 && Date.now() >= this.deadline)
      throw new ExecutionError("Timeout");
  };

  /** Close the budget: queries made after an evaluation are not charged against it. */
  endBudget(): void {
    this.deadline = Number.POSITIVE_INFINITY;
  }

  addFact(origin: Origin, fact: Fact): void {
    let bucket = this.facts.get(origin.key);
    if (!bucket) {
      bucket = { origin, items: new Map() };
      this.facts.set(origin.key, bucket);
    }
    const key = factKey(fact);
    if (!bucket.items.has(key)) {
      bucket.items.set(key, fact);
      this.generation++;
    }
  }

  addRule(origin: number, trusted: TrustedOrigins, rule: Rule): void {
    this.rules.push({ origin, trusted, rule });
  }

  factCount(): number {
    let n = 0;
    for (const b of this.facts.values()) n += b.items.size;
    return n;
  }

  private visible(trusted: TrustedOrigins): FactIndex {
    const cached = this.indexCache.get(trusted.key);
    if (cached && cached.generation === this.generation) return cached.index;

    const index: FactIndex = new Map();
    for (const bucket of this.facts.values()) {
      if (!trusted.contains(bucket.origin)) continue;
      for (const f of bucket.items.values()) {
        const key = `${f.predicate.name}/${f.predicate.terms.length}`;
        const list = index.get(key);
        if (list) list.push([bucket.origin, f]);
        else index.set(key, [[bucket.origin, f]]);
      }
    }
    this.indexCache.set(trusted.key, { generation: this.generation, index });
    return index;
  }

  /** naive fixpoint: apply every rule until no new fact appears */
  run(limits: RunLimits = DEFAULT_LIMITS): void {
    // The budget stays open after `run` returns, so the checks and policies the
    // authorizer evaluates next are bounded by it too; `endBudget` closes it.
    const deadline = Date.now() + limits.maxTimeMs;
    this.deadline = deadline;
    let index = 0;
    for (;;) {
      const generated: [Origin, Fact][] = [];
      // Distinct facts this iteration adds. Counted as they are derived, so
      // `maxFacts` fires the moment the world WOULD exceed it — the verdict the
      // end-of-iteration check reaches, without enumerating the rest of the
      // product first. On the last permitted iteration the reference reports
      // TooManyIterations ahead of TooManyFacts, so the early exit stands aside.
      const fresh = new Set<string>();
      const base = this.factCount();
      const lastIteration = index + 1 === limits.maxIterations;
      for (const { origin, trusted, rule } of this.rules) {
        const facts = this.visible(trusted);
        for (const [o, f] of this.apply(rule, facts, origin)) {
          generated.push([o, f]);
          const key = factKey(f);
          if (this.facts.get(o.key)?.items.has(key)) continue;
          fresh.add(`${o.key}|${key}`);
          if (!lastIteration && base + fresh.size >= limits.maxFacts)
            throw new ExecutionError("TooManyFacts");
        }
      }
      const before = this.factCount();
      for (const [o, f] of generated) this.addFact(o, f);
      if (this.factCount() === before) break;

      index++;
      if (index === limits.maxIterations) throw new ExecutionError("TooManyIterations");
      if (this.factCount() >= limits.maxFacts) throw new ExecutionError("TooManyFacts");
      if (Date.now() >= deadline) throw new ExecutionError("Timeout");
    }
    this.iterations += index;
  }

  *apply(rule: Rule, facts: FactIndex, ruleOrigin: number): Generator<[Origin, Fact]> {
    const variables = variablesOf(rule);
    for (const [origin, bindings] of combine(rule.body, facts, new Map(), variables, this.tick)) {
      let pass = true;
      for (const ops of rule.expressions) {
        const res = evaluateExpression(ops, bindings, this.externs);
        if (res.t !== "bool") throw new ExecutionError("InvalidType");
        if (!res.v) {
          pass = false;
          break;
        }
      }
      if (!pass) continue;
      const terms: Term[] = [];
      let complete = true;
      for (const t of rule.head.terms) {
        if (t.t === "var") {
          const bound = bindings.get(t.v);
          if (bound === undefined) {
            complete = false; // head variables must be bound in the body
            break;
          }
          terms.push(bound);
        } else terms.push(t);
      }
      if (!complete) continue;
      yield [origin.with(ruleOrigin), { predicate: { name: rule.head.name, terms } }];
    }
  }

  /** every distinct fact `rule` derives from the facts `trusted` can see */
  query(rule: Rule, trusted: TrustedOrigins): Predicate[] {
    const seen = new Map<string, Predicate>();
    for (const [, fact] of this.apply(rule, this.visible(trusted), AUTHORIZER)) {
      const key = factKey(fact);
      if (!seen.has(key)) seen.set(key, fact.predicate);
    }
    return [...seen.values()];
  }

  /** `check if` / policies: does at least one combination match? */
  queryMatch(rule: Rule, origin: number, trusted: TrustedOrigins): boolean {
    for (const _ of this.apply(rule, this.visible(trusted), origin)) return true;
    return false;
  }

  /** `check all`: every matching combination must satisfy the expressions */
  queryMatchAll(rule: Rule, trusted: TrustedOrigins): boolean {
    const variables = variablesOf(rule);
    let found = false;
    for (const [, bindings] of combine(
      rule.body,
      this.visible(trusted),
      new Map(),
      variables,
      this.tick,
    )) {
      found = true;
      for (const ops of rule.expressions) {
        const res = evaluateExpression(ops, bindings, this.externs);
        if (res.t !== "bool") throw new ExecutionError("InvalidType");
        if (!res.v) return false;
      }
    }
    return found;
  }
}
