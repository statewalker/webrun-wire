/**
 * Turns a serialized token plus authorizer code into an authorization result,
 * mirroring the evaluation order of the reference implementation.
 */

import { revocationIds, verifyToken, verifyTokenAsync } from "./crypto.js";
import {
  AUTHORIZER,
  type Check,
  DEFAULT_LIMITS,
  ExecutionError,
  type ExternFn,
  type Fact,
  type MapKey,
  normalizeSet,
  type Op,
  Origin,
  type Predicate,
  type Rule,
  type RunLimits,
  type Scope,
  type Term,
  TrustedOrigins,
  trustedOriginsFromScopes,
  World,
} from "./datalog.js";
import { type Params, ParseError, Parser, type Statement } from "./parser.js";
import { printCheck, printPolicy, printPredicate, printRule } from "./print.js";
import {
  type BiscuitMsg,
  type BlockMsg,
  decodeBiscuit,
  decodeBlock,
  type MapEntryMsg,
  type OpMsg,
  type PredicateMsg,
  ProtoError,
  type RuleMsg,
  type ScopeMsg,
  type TermMsg,
} from "./proto.js";
import { validateBlockVersion } from "./version.js";

export const DEFAULT_SYMBOLS = [
  "read",
  "write",
  "resource",
  "operation",
  "right",
  "time",
  "role",
  "owner",
  "tenant",
  "namespace",
  "user",
  "team",
  "service",
  "admin",
  "email",
  "group",
  "member",
  "ip_address",
  "client",
  "client_ip",
  "domain",
  "path",
  "version",
  "cluster",
  "node",
  "hostname",
  "nonce",
  "query",
];
const OFFSET = 1024;

export class TokenError extends Error {
  constructor(
    readonly kind: "Format" | "Symbol",
    message: string,
  ) {
    super(message);
  }
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const keyString = (algorithm: number, key: Uint8Array): string =>
  `${algorithm === 0 ? "ed25519" : "secp256r1"}/${hex(key)}`;

/* ------------------------------------------------------ symbol resolution */

class Symbols {
  constructor(
    private readonly table: string[],
    private readonly keys: string[],
  ) {}
  get(index: number): string {
    if (index < OFFSET) {
      const s = DEFAULT_SYMBOLS[index];
      if (s === undefined) throw new TokenError("Symbol", `unknown default symbol ${index}`);
      return s;
    }
    const s = this.table[index - OFFSET];
    if (s === undefined) throw new TokenError("Symbol", `unknown symbol ${index}`);
    return s;
  }
  publicKey(index: number): string {
    const k = this.keys[index];
    if (k === undefined) throw new TokenError("Symbol", `unknown public key ${index}`);
    return k;
  }
}

/* ------------------------------------------------- proto -> runtime model */

function convTerm(t: TermMsg, s: Symbols): Term {
  switch (t.kind) {
    case "variable":
      return { t: "var", v: t.value };
    case "integer":
      return { t: "int", v: t.value };
    case "string":
      return { t: "str", v: s.get(t.value) };
    case "date":
      return { t: "date", v: t.value };
    case "bytes":
      return { t: "bytes", v: t.value };
    case "bool":
      return { t: "bool", v: t.value };
    case "null":
      return { t: "null" };
    case "set":
      return { t: "set", v: normalizeSet(t.value.map((x) => convTerm(x, s))) };
    case "array":
      return { t: "array", v: t.value.map((x) => convTerm(x, s)) };
    case "map":
      return {
        t: "map",
        v: t.value.map((e: MapEntryMsg): [MapKey, Term] => [
          e.key.kind === "integer"
            ? { t: "int", v: e.key.value }
            : { t: "str", v: s.get(e.key.value) },
          convTerm(e.value, s),
        ]),
      };
  }
}

const convPredicate = (p: PredicateMsg, s: Symbols): Predicate => ({
  name: s.get(p.name),
  terms: p.terms.map((t) => convTerm(t, s)),
});

function convOps(ops: OpMsg[], s: Symbols): Op[] {
  return ops.map((op): Op => {
    switch (op.kind) {
      case "value":
        return { kind: "value", value: convTerm(op.value, s) };
      case "unary":
        return {
          kind: "unary",
          op: op.op,
          ffi: op.ffiName !== undefined ? s.get(op.ffiName) : undefined,
        };
      case "binary":
        return {
          kind: "binary",
          op: op.op,
          ffi: op.ffiName !== undefined ? s.get(op.ffiName) : undefined,
        };
      case "closure":
        return { kind: "closure", params: op.params, ops: convOps(op.ops, s) };
      default:
        // unreachable for a well-typed OpMsg; loud rather than `undefined`
        throw new ProtoError(`unknown expression op kind ${(op as { kind: string }).kind}`);
    }
  });
}

const convScope = (sc: ScopeMsg, s: Symbols): Scope =>
  sc.kind === "type"
    ? sc.value === 0
      ? { kind: "authority" }
      : { kind: "previous" }
    : { kind: "publicKey", key: s.publicKey(sc.value) };

const convRule = (r: RuleMsg, s: Symbols): Rule => ({
  head: convPredicate(r.head, s),
  body: r.body.map((p) => convPredicate(p, s)),
  expressions: r.expressions.map((e) => convOps(e, s)),
  scopes: r.scope.map((sc) => convScope(sc, s)),
});

export interface RuntimeBlock {
  facts: Fact[];
  rules: Rule[];
  checks: Check[];
  scopes: Scope[];
  externalKey?: string;
  /** variable id -> name, for printing rules in error messages */
  varNames: Map<number, string>;
}

function convBlock(b: BlockMsg, s: Symbols, externalKey?: string): RuntimeBlock {
  const varNames = new Map<number, string>();
  const collectTerm = (t: TermMsg): void => {
    if (t.kind === "variable") varNames.set(t.value, s.get(t.value));
    else if (t.kind === "set" || t.kind === "array") t.value.forEach(collectTerm);
    else if (t.kind === "map")
      t.value.forEach((e) => {
        collectTerm(e.value);
      });
  };
  const collectOps = (ops: OpMsg[]): void => {
    for (const op of ops) {
      if (op.kind === "value") collectTerm(op.value);
      else if (op.kind === "closure") {
        // closure parameters are variables that never appear in a predicate
        for (const param of op.params) varNames.set(param, s.get(param));
        collectOps(op.ops);
      }
    }
  };
  const collect = (r: RuleMsg): void => {
    for (const p of [r.head, ...r.body]) p.terms.forEach(collectTerm);
    r.expressions.forEach(collectOps);
  };
  for (const r of b.rules) collect(r);
  for (const c of b.checks) for (const q of c.queries) collect(q);
  return {
    varNames,
    facts: b.facts.map((f) => ({ predicate: convPredicate(f, s) })),
    rules: b.rules.map((r) => convRule(r, s)),
    checks: b.checks.map((c) => ({
      queries: c.queries.map((q) => convRule(q, s)),
      kind: c.kind === 1 ? "all" : c.kind === 2 ? "reject" : "one",
    })),
    scopes: b.scope.map((sc) => convScope(sc, s)),
    externalKey,
  };
}

/* ------------------------------------------------------------ token model */

export interface LoadedToken {
  blocks: RuntimeBlock[];
  publicKeyToBlockIds: Map<string, number[]>;
  revocationIds: string[];
  /** the issuer's key identifier, when the token carries one — callers use it
   *  to pick the right root key during rotation */
  rootKeyId?: number;
}

export function loadToken(
  bytes: Uint8Array,
  rootPublicKey: Uint8Array,
  /** the root key's algorithm: 0 = Ed25519, 1 = secp256r1 */
  rootAlgorithm: 0 | 1 = 0,
): LoadedToken {
  const token = decodeBiscuit(bytes);
  verifyToken(token, rootPublicKey, rootAlgorithm);
  return toLoadedToken(token);
}

/**
 * `loadToken`, verifying signatures with the platform's WebCrypto Ed25519 where
 * available — see `verifyTokenAsync`. Same result, same errors.
 */
export async function loadTokenAsync(
  bytes: Uint8Array,
  rootPublicKey: Uint8Array,
  rootAlgorithm: 0 | 1 = 0,
): Promise<LoadedToken> {
  const token = decodeBiscuit(bytes);
  await verifyTokenAsync(token, rootPublicKey, rootAlgorithm);
  return toLoadedToken(token);
}

function toLoadedToken(token: BiscuitMsg): LoadedToken {
  const signed = [token.authority, ...token.blocks];
  const decoded = signed.map((sb) => decodeBlock(sb.block));

  // token-wide tables, extended block by block (third-party blocks are isolated)
  const globalSymbols: string[] = [];
  const globalKeys: string[] = [];
  const extend = (list: string[], items: string[]): void => {
    for (const i of items) if (!list.includes(i)) list.push(i);
  };

  const blocks: RuntimeBlock[] = [];
  const publicKeyToBlockIds = new Map<string, number[]>();

  for (let id = 0; id < decoded.length; id++) {
    const raw = decoded[id];
    const ext = signed[id].externalSignature;
    const externalKey = ext ? keyString(ext.publicKey.algorithm, ext.publicKey.key) : undefined;
    const blockKeys = raw.publicKeys.map((k) => keyString(k.algorithm, k.key));

    if (externalKey === undefined) {
      // symbols of a first-party block join the shared table
      for (const sym of raw.symbols) {
        if (globalSymbols.includes(sym)) throw new TokenError("Format", "symbol table overlap");
        globalSymbols.push(sym);
      }
      extend(globalKeys, blockKeys);
      const block = convBlock(raw, new Symbols(globalSymbols, globalKeys), undefined);
      validateBlockVersion(raw.version, raw.checks, false, block);
      blocks.push(block);
    } else {
      // third-party block: its own symbol and public key tables
      const block = convBlock(raw, new Symbols(raw.symbols, blockKeys), externalKey);
      validateBlockVersion(raw.version, raw.checks, true, block);
      blocks.push(block);
      extend(globalKeys, blockKeys);
      const ids = publicKeyToBlockIds.get(externalKey) ?? [];
      ids.push(id);
      publicKeyToBlockIds.set(externalKey, ids);
    }
  }

  return {
    blocks,
    publicKeyToBlockIds,
    revocationIds: revocationIds(token).map(hex),
    rootKeyId: token.rootKeyId,
  };
}

/**
 * Reads the key identifier from a token **without verifying it**, so a caller
 * can choose which root key to verify against. The token is untrusted at this
 * point: the id is a hint, not a claim.
 */
export function peekRootKeyId(bytes: Uint8Array): number | undefined {
  return decodeBiscuit(bytes).rootKeyId;
}

/** a block rule whose head uses a variable the body never binds is invalid */
function headVariablesAreBound(rule: Rule): boolean {
  const bound = new Set<number>();
  for (const p of rule.body) for (const t of p.terms) if (t.t === "var") bound.add(t.v);
  return rule.head.terms.every((t) => t.t !== "var" || bound.has(t.v));
}

/* ------------------------------------------------------------- authorizer */

export type FailedCheck =
  | { source: "authorizer"; checkId: number; rule: string }
  | { source: "block"; blockId: number; checkId: number; rule: string };

export type AuthorizationResult =
  | { kind: "ok"; policy: number }
  | { kind: "unauthorized"; policy: { allow: number } | { deny: number }; checks: FailedCheck[] }
  | { kind: "noMatchingPolicy"; checks: FailedCheck[] }
  | { kind: "execution"; error: string }
  | { kind: "invalidBlockRule"; blockId: number; rule: string }
  | { kind: "format"; error: string };

/** the shape of the `world` snapshot in the official sample corpus */
export interface WorldSnapshot {
  facts: { origin: (number | null)[]; facts: string[] }[];
  rules: { origin: number; rules: string[] }[];
  checks: { origin: number; checks: string[] }[];
  policies: string[];
}

export interface AuthorizeDetails {
  result: AuthorizationResult;
  world: WorldSnapshot;
}

interface AuthorizerCode {
  facts: Fact[];
  rules: Rule[];
  checks: Check[];
  policies: { kind: "allow" | "deny"; queries: Rule[] }[];
  scopes: Scope[];
  varNames: Map<number, string>;
}

/**
 * Parse authorizer (or block) source. `{name}` parameters are bound from
 * `params` as terms; an unbound or an unused parameter is a `ParseError`, as it
 * is in the reference.
 */
export function parseAuthorizer(src: string, params?: Params): AuthorizerCode {
  const out: AuthorizerCode = {
    facts: [],
    rules: [],
    checks: [],
    policies: [],
    scopes: [],
    varNames: new Map(),
  };
  const parser = new Parser(src, undefined, params);
  const statements: Statement[] = parser.parse();
  const unused = parser.unusedParameters();
  if (unused.length > 0)
    throw new ParseError(`unused parameter${unused.length > 1 ? "s" : ""} {${unused.join("}, {")}}`);
  out.varNames = parser.variableNames();
  for (const st of statements) {
    if (st.k === "fact") out.facts.push(st.fact);
    else if (st.k === "rule") out.rules.push(st.rule);
    else if (st.k === "check") out.checks.push(st.check);
    else if (st.k === "policy") out.policies.push({ kind: st.kind, queries: st.queries });
    else out.scopes.push(...st.scopes);
  }
  return out;
}

export interface AuthorizeOptions {
  limits?: RunLimits;
  /** extern functions callable as `.extern::name(...)` */
  externs?: Map<string, ExternFn>;
  /** values for `{name}` parameters in the authorizer code */
  params?: Params;
}

export interface QueryOptions {
  /** values for `{name}` parameters in the query rule */
  params?: Params;
}

/** One authorizer run: its result, plus read access to the world it produced. */
export interface Evaluation {
  readonly result: AuthorizationResult;
  /**
   * Every distinct fact `rule` derives from the evaluated world — the
   * reference's `Authorizer::query`. The rule sees what the authorizer sees
   * (authority block and authorizer facts) unless it says `trusting ...`.
   * Throws when the evaluation itself did not complete.
   */
  query(rule: string, options?: QueryOptions): Predicate[];
  /** The post-run world, in the shape the official sample corpus records it. */
  snapshot(): WorldSnapshot;
}

export function authorize(
  token: LoadedToken | null,
  authorizerSrc: string,
  options: AuthorizeOptions = {},
): AuthorizationResult {
  return evaluate(token, authorizerSrc, options).result;
}

const EMPTY_WORLD: WorldSnapshot = { facts: [], rules: [], checks: [], policies: [] };

/** Same as `authorize`, and also returns the post-run world, in the shape the
 *  official sample corpus records it. */
export function authorizeDetailed(
  token: LoadedToken | null,
  authorizerSrc: string,
  options: AuthorizeOptions = {},
): AuthorizeDetails {
  const evaluation = evaluate(token, authorizerSrc, options);
  return { result: evaluation.result, world: evaluation.snapshot() };
}

const NO_TOKEN: LoadedToken = { blocks: [], publicKeyToBlockIds: new Map(), revocationIds: [] };

/**
 * Run the authorizer against a verified token — or against no token at all,
 * for a decision made from the authorizer's own facts and rules.
 */
export function evaluate(
  loadedToken: LoadedToken | null,
  authorizerSrc: string,
  options: AuthorizeOptions = {},
): Evaluation {
  const token = loadedToken ?? NO_TOKEN;
  const limits = options.limits ?? DEFAULT_LIMITS;
  let code: AuthorizerCode;
  try {
    code = parseAuthorizer(authorizerSrc, options.params);
  } catch (e) {
    return unusable({ kind: "format", error: (e as Error).message });
  }

  const world = new World();
  if (options.externs) world.externs = options.externs;
  const keys = token.publicKeyToBlockIds;
  const blockTrusted: TrustedOrigins[] = [];

  for (let id = 0; id < token.blocks.length; id++) {
    const block = token.blocks[id];
    const trusted = trustedOriginsFromScopes(block.scopes, TrustedOrigins.default(), id, keys);
    blockTrusted.push(trusted);
    const origin = Origin.of(id);
    for (const f of block.facts) world.addFact(origin, f);
    for (const r of block.rules) {
      if (!headVariablesAreBound(r))
        return unusable({
          kind: "invalidBlockRule",
          blockId: 0, // the reference implementation always reports 0 here
          rule: printRule(r, (v) => block.varNames.get(v) ?? String(v)),
        });
      world.addRule(id, trustedOriginsFromScopes(r.scopes, trusted, id, keys), r);
    }
  }

  const authorizerTrusted = trustedOriginsFromScopes(
    code.scopes,
    TrustedOrigins.default(),
    AUTHORIZER,
    keys,
  );
  const authorizerOrigin = Origin.of(AUTHORIZER);
  for (const f of code.facts) world.addFact(authorizerOrigin, f);
  for (const r of code.rules)
    world.addRule(
      AUTHORIZER,
      trustedOriginsFromScopes(r.scopes, authorizerTrusted, AUTHORIZER, keys),
      r,
    );

  const name = (id: number): ((v: number) => string) =>
    id === AUTHORIZER
      ? (v) => code.varNames.get(v) ?? String(v)
      : (v) => token.blocks[id]?.varNames.get(v) ?? String(v);

  // in the corpus, a fact's authorizer origin is `null`, but a rule's or
  // check's authorizer origin is the raw u64 block id
  const blockId = (id: number): number | null => (id === AUTHORIZER ? null : id);
  const AUTHORIZER_U64 = Number(18446744073709551615n);
  const ruleOrigin = (id: number): number => (id === AUTHORIZER ? AUTHORIZER_U64 : id);

  const snapshot = (): WorldSnapshot => {
    const factGroups = [...world.facts.values()]
      .filter((b) => b.items.size > 0)
      .map((b) => ({
        origin: b.origin.ids.map(blockId).sort((x, y) => (x ?? -1) - (y ?? -1)),
        facts: [...b.items.values()].map((f) => printPredicate(f.predicate, () => "?")).sort(),
      }))
      .sort((a, x) => compareOrigins(a.origin, x.origin));

    const ruleGroups = new Map<number, string[]>();
    for (const { origin, rule } of world.rules) {
      const list = ruleGroups.get(origin) ?? [];
      list.push(printRule(rule, name(origin)));
      ruleGroups.set(origin, list);
    }
    const checkGroups: { origin: number; checks: string[] }[] = [];
    code.checks.forEach((c) => {
      const entry = checkGroups.find((g) => g.origin === AUTHORIZER_U64);
      const text = printCheck(c, name(AUTHORIZER));
      if (entry) entry.checks.push(text);
      else checkGroups.push({ origin: AUTHORIZER_U64, checks: [text] });
    });
    token.blocks.forEach((b, id) => {
      if (b.checks.length === 0) return;
      checkGroups.push({ origin: id, checks: b.checks.map((c) => printCheck(c, name(id))) });
    });

    return {
      facts: factGroups,
      rules: [...ruleGroups.entries()]
        .map(([origin, rules]) => ({ origin: ruleOrigin(origin), rules: rules.sort() }))
        .sort((a, b) => (a.origin ?? -1) - (b.origin ?? -1)),
      checks: checkGroups.sort((a, b) => (a.origin ?? -1) - (b.origin ?? -1)),
      policies: code.policies.map((p) => printPolicy(p.kind, p.queries, name(AUTHORIZER))),
    };
  };

  let failure: ExecutionError | undefined;
  const settled = (result: AuthorizationResult): Evaluation => ({
    result,
    snapshot,
    query(src: string, queryOptions: QueryOptions = {}): Predicate[] {
      if (failure) throw failure;
      const parsed = parseAuthorizer(`${src};`, queryOptions.params);
      const count =
        parsed.facts.length + parsed.rules.length + parsed.checks.length + parsed.policies.length;
      if (count !== 1 || parsed.rules.length !== 1)
        throw new ParseError("a query must be exactly one rule");
      const rule = parsed.rules[0];
      const trusted = trustedOriginsFromScopes(rule.scopes, authorizerTrusted, AUTHORIZER, keys);
      return world.query(rule, trusted);
    },
  });

  try {
    world.run(limits);
  } catch (e) {
    if (e instanceof ExecutionError) {
      failure = e;
      return settled({ kind: "execution", error: e.kind });
    }
    throw e;
  }

  const errors: FailedCheck[] = [];
  const runCheck = (check: Check, blockId: number, defaults: TrustedOrigins): boolean => {
    for (const query of check.queries) {
      const trusted = trustedOriginsFromScopes(query.scopes, defaults, blockId, keys);
      const res =
        check.kind === "all"
          ? world.queryMatchAll(query, trusted)
          : check.kind === "reject"
            ? !world.queryMatch(query, blockId, trusted)
            : world.queryMatch(query, blockId, trusted);
      if (res) return true;
    }
    return false;
  };

  try {
    // 1. authorizer checks
    code.checks.forEach((check, i) => {
      if (!runCheck(check, AUTHORIZER, authorizerTrusted))
        errors.push({
          source: "authorizer",
          checkId: i,
          rule: printCheck(check, name(AUTHORIZER)),
        });
    });

    // 2. authority block checks
    token.blocks[0]?.checks.forEach((check, j) => {
      if (!runCheck(check, 0, blockTrusted[0]))
        errors.push({ source: "block", blockId: 0, checkId: j, rule: printCheck(check, name(0)) });
    });

    // 3. policies (first match wins)
    let policyResult: { allow: number } | { deny: number } | null = null;
    outer: for (const [i, policy] of code.policies.entries()) {
      for (const query of policy.queries) {
        const trusted = trustedOriginsFromScopes(query.scopes, authorizerTrusted, AUTHORIZER, keys);
        if (world.queryMatch(query, AUTHORIZER, trusted)) {
          policyResult = policy.kind === "allow" ? { allow: i } : { deny: i };
          break outer;
        }
      }
    }

    // 4. checks of the remaining blocks
    for (let id = 1; id < token.blocks.length; id++) {
      token.blocks[id].checks.forEach((check, j) => {
        if (!runCheck(check, id, blockTrusted[id]))
          errors.push({ source: "block", blockId: id, checkId: j, rule: printCheck(check, name(id)) });
      });
    }

    const result: AuthorizationResult =
      policyResult === null
        ? { kind: "noMatchingPolicy", checks: errors }
        : "allow" in policyResult && errors.length === 0
          ? { kind: "ok", policy: policyResult.allow }
          : { kind: "unauthorized", policy: policyResult, checks: errors };
    return settled(result);
  } catch (e) {
    if (e instanceof ExecutionError) {
      failure = e;
      return settled({ kind: "execution", error: e.kind });
    }
    throw e;
  }
}

/** An evaluation that never produced a world: the result says why, and queries refuse. */
function unusable(result: AuthorizationResult): Evaluation {
  return {
    result,
    snapshot: () => EMPTY_WORLD,
    query() {
      throw new Error(`cannot query an evaluation that ended in ${result.kind}`);
    },
  };
}

function compareOrigins(a: (number | null)[], b: (number | null)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] === undefined ? -Infinity : (a[i] ?? -1);
    const y = b[i] === undefined ? -Infinity : (b[i] ?? -1);
    if (x !== y) return x - y;
  }
  return 0;
}
