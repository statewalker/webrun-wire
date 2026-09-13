/**
 * The write path: minting tokens, attenuating them with extra blocks, and
 * sealing them. New blocks are signed with signature payload version 1, and
 * declare the lowest Datalog version their content legally requires.
 */

import { DEFAULT_SYMBOLS, parseAuthorizer } from "./authorizer.js";
import {
  authorityPayloadV1,
  blockPayloadV1,
  externalPayloadV1,
  generateKeypair,
  publicKeyFromSecret,
  sealPayloadV0,
  sign,
} from "./crypto.js";
import type { Check, Op, Predicate, Rule, Scope, Term } from "./datalog.js";
import {
  type BiscuitMsg,
  type BlockMsg,
  decodeBiscuit,
  decodeBlock,
  encodeBiscuit,
  encodeBlock,
  type MapKeyMsg,
  type OpMsg,
  type PredicateMsg,
  type PublicKeyMsg,
  type RuleMsg,
  type ScopeMsg,
  type TermMsg,
} from "./proto.js";
import { DATALOG_3_2, requiredVersion } from "./version.js";

const SIGNATURE_VERSION = 1;
const OFFSET = 1024;

export class BuilderError extends Error {}

export interface Keypair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}
export { generateKeypair };

/* -------------------------------------------------- symbol table building */

class SymbolWriter {
  /** symbols added by this block, in insertion order */
  readonly added: string[] = [];
  readonly addedKeys: string[] = [];
  constructor(
    private readonly known: string[] = [],
    private readonly knownKeys: string[] = [],
  ) {}

  insert(s: string): number {
    const d = DEFAULT_SYMBOLS.indexOf(s);
    if (d >= 0) return d;
    const k = this.known.indexOf(s);
    if (k >= 0) return OFFSET + k;
    let i = this.added.indexOf(s);
    if (i < 0) i = this.added.push(s) - 1;
    return OFFSET + this.known.length + i;
  }

  insertKey(key: string): number {
    const k = this.knownKeys.indexOf(key);
    if (k >= 0) return k;
    let i = this.addedKeys.indexOf(key);
    if (i < 0) i = this.addedKeys.push(key) - 1;
    return this.knownKeys.length + i;
  }
}

const parseKeyString = (key: string): PublicKeyMsg => {
  const [alg, h] = key.split("/");
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  return { algorithm: alg === "secp256r1" ? 1 : 0, key: bytes };
};

/* -------------------------------------------------- runtime -> proto model */

function toTerm(t: Term, w: SymbolWriter): TermMsg {
  switch (t.t) {
    case "var":
      return { kind: "variable", value: t.v };
    case "int":
      return { kind: "integer", value: t.v };
    case "str":
      return { kind: "string", value: w.insert(t.v) };
    case "date":
      return { kind: "date", value: t.v };
    case "bytes":
      return { kind: "bytes", value: t.v };
    case "bool":
      return { kind: "bool", value: t.v };
    case "null":
      return { kind: "null" };
    case "set":
      return { kind: "set", value: t.v.map((x) => toTerm(x, w)) };
    case "array":
      return { kind: "array", value: t.v.map((x) => toTerm(x, w)) };
    case "map":
      return {
        kind: "map",
        value: t.v.map((e) => ({
          key: (e[0].t === "int"
            ? { kind: "integer", value: e[0].v }
            : { kind: "string", value: w.insert(e[0].v) }) as MapKeyMsg,
          value: toTerm(e[1], w),
        })),
      };
  }
}

const toPredicate = (p: Predicate, w: SymbolWriter): PredicateMsg => ({
  name: w.insert(p.name),
  terms: p.terms.map((t) => toTerm(t, w)),
});

const toOps = (ops: Op[], w: SymbolWriter): OpMsg[] =>
  ops.map((op): OpMsg => {
    switch (op.kind) {
      case "value":
        return { kind: "value", value: toTerm(op.value, w) };
      case "unary":
        return { kind: "unary", op: op.op, ffiName: op.ffi ? w.insert(op.ffi) : undefined };
      case "binary":
        return { kind: "binary", op: op.op, ffiName: op.ffi ? w.insert(op.ffi) : undefined };
      case "closure":
        return { kind: "closure", params: op.params, ops: toOps(op.ops, w) };
      default:
        // unreachable for a well-typed Op; loud rather than `undefined`
        throw new Error(`unknown expression op kind ${(op as { kind: string }).kind}`);
    }
  });

const toScope = (s: Scope, w: SymbolWriter): ScopeMsg =>
  s.kind === "authority"
    ? { kind: "type", value: 0 }
    : s.kind === "previous"
      ? { kind: "type", value: 1 }
      : { kind: "publicKey", value: w.insertKey(s.key) };

const toRule = (r: Rule, w: SymbolWriter): RuleMsg => ({
  head: toPredicate(r.head, w),
  body: r.body.map((p) => toPredicate(p, w)),
  expressions: r.expressions.map((e) => toOps(e, w)),
  scope: r.scopes.map((s) => toScope(s, w)),
});

/* -------------------------------------------------------------- block build */

export interface BlockContent {
  facts: { predicate: Predicate }[];
  rules: Rule[];
  checks: Check[];
  scopes: Scope[];
}

export function buildBlockMsg(
  content: BlockContent,
  knownSymbols: string[] = [],
  knownKeys: string[] = [],
  minVersion = 0,
): BlockMsg {
  const w = new SymbolWriter(knownSymbols, knownKeys);
  const facts = content.facts.map((f) => toPredicate(f.predicate, w));
  const rules = content.rules.map((r) => toRule(r, w));
  const checks = content.checks.map((c) => ({
    queries: c.queries.map((q) => toRule(q, w)),
    kind: (c.kind === "all" ? 1 : c.kind === "reject" ? 2 : undefined) as 0 | 1 | 2 | undefined,
  }));
  const scope = content.scopes.map((s) => toScope(s, w));
  return {
    symbols: w.added,
    version: Math.max(requiredVersion(content), minVersion),
    facts,
    rules,
    checks,
    scope,
    publicKeys: w.addedKeys.map(parseKeyString),
  };
}

const contentFromCode = (code: string): BlockContent => {
  const parsed = parseAuthorizer(code);
  if (parsed.policies.length)
    throw new BuilderError("allow/deny policies belong to the authorizer, not to a block");
  return { facts: parsed.facts, rules: parsed.rules, checks: parsed.checks, scopes: parsed.scopes };
};

/* ---------------------------------------------------- accumulated tables */

function knownTables(token: BiscuitMsg): { symbols: string[]; keys: string[] } {
  const symbols: string[] = [];
  const keys: string[] = [];
  const signed = [token.authority, ...token.blocks];
  for (const sb of signed) {
    const b = decodeBlock(sb.block);
    if (!sb.externalSignature) symbols.push(...b.symbols);
    for (const k of b.publicKeys) {
      const s = `${k.algorithm === 1 ? "secp256r1" : "ed25519"}/${Array.from(k.key, (x) => x.toString(16).padStart(2, "0")).join("")}`;
      if (!keys.includes(s)) keys.push(s);
    }
  }
  return { symbols, keys };
}

/* ------------------------------------------------------------- public API */

export interface BuildOptions {
  rootKeyId?: number;
  /** supply a next keypair instead of generating one (tests, determinism) */
  nextKeypair?: Keypair;
  algorithm?: 0 | 1;
}

/** Mint a new token whose authority block holds `code`. */
export function buildToken(
  rootSecret: Uint8Array,
  code: string | BlockContent,
  options: BuildOptions = {},
): Uint8Array {
  const algorithm = options.algorithm ?? 0;
  const content = typeof code === "string" ? contentFromCode(code) : code;
  const blockBytes = encodeBlock(buildBlockMsg(content));
  const next = options.nextKeypair ?? generateKeypair(algorithm);
  const nextKey: PublicKeyMsg = { algorithm, key: next.publicKey };

  const payload = authorityPayloadV1(blockBytes, nextKey, SIGNATURE_VERSION);
  const signature = sign(payload, rootSecret, algorithm);

  return encodeBiscuit({
    rootKeyId: options.rootKeyId,
    authority: { block: blockBytes, nextKey, signature, version: SIGNATURE_VERSION },
    blocks: [],
    proof: { kind: "nextSecret", value: next.secretKey },
  });
}

/** Append an attenuation block. Uses the token's own proof secret to sign. */
export function attenuate(
  tokenBytes: Uint8Array,
  code: string | BlockContent,
  options: BuildOptions = {},
): Uint8Array {
  const token = decodeBiscuit(tokenBytes);
  if (token.proof.kind !== "nextSecret")
    throw new BuilderError("the token is sealed and cannot be attenuated");

  const algorithm = options.algorithm ?? 0;
  const currentSecret = token.proof.value;
  const previous = token.blocks.length ? token.blocks[token.blocks.length - 1] : token.authority;
  const currentAlgorithm = previous.nextKey.algorithm;

  const tables = knownTables(token);
  const content = typeof code === "string" ? contentFromCode(code) : code;
  const blockBytes = encodeBlock(buildBlockMsg(content, tables.symbols, tables.keys));

  const next = options.nextKeypair ?? generateKeypair(algorithm);
  const nextKey: PublicKeyMsg = { algorithm, key: next.publicKey };
  const payload = blockPayloadV1(
    blockBytes,
    nextKey,
    undefined,
    previous.signature,
    SIGNATURE_VERSION,
  );
  const signature = sign(payload, currentSecret, currentAlgorithm);

  token.blocks.push({ block: blockBytes, nextKey, signature, version: SIGNATURE_VERSION });
  token.proof = { kind: "nextSecret", value: next.secretKey };
  return encodeBiscuit(token);
}

/** Seal a token so no further block can be appended. */
export function sealToken(tokenBytes: Uint8Array): Uint8Array {
  const token = decodeBiscuit(tokenBytes);
  if (token.proof.kind !== "nextSecret") return tokenBytes;
  const last = token.blocks.length ? token.blocks[token.blocks.length - 1] : token.authority;
  const signature = sign(sealPayloadV0(last), token.proof.value, last.nextKey.algorithm);
  token.proof = { kind: "finalSignature", value: signature };
  return encodeBiscuit(token);
}

/* -------------------------------------------------- third-party blocks */

export interface ThirdPartyRequest {
  /** signature of the block this attenuation will follow */
  previousSignature: Uint8Array;
}

/** What a token holder sends to a third party that will sign a block. */
export function thirdPartyRequest(tokenBytes: Uint8Array): ThirdPartyRequest {
  const token = decodeBiscuit(tokenBytes);
  const last = token.blocks.length ? token.blocks[token.blocks.length - 1] : token.authority;
  return { previousSignature: last.signature };
}

export interface ThirdPartyResponse {
  block: Uint8Array;
  signature: Uint8Array;
  publicKey: PublicKeyMsg;
}

/** The third party builds and signs a block without holding the token. */
export function thirdPartyBlock(
  request: ThirdPartyRequest,
  externalSecret: Uint8Array,
  code: string | BlockContent,
  algorithm: 0 | 1 = 0,
): ThirdPartyResponse {
  const content = typeof code === "string" ? contentFromCode(code) : code;
  // a third-party block carries its own symbol table, so it starts from empty,
  // and third-party blocks themselves require datalog v3.2+
  const blockBytes = encodeBlock(buildBlockMsg(content, [], [], DATALOG_3_2));
  const payload = externalPayloadV1(blockBytes, request.previousSignature, SIGNATURE_VERSION);
  return {
    block: blockBytes,
    signature: sign(payload, externalSecret, algorithm),
    publicKey: { algorithm, key: publicKeyFromSecret(externalSecret, algorithm) },
  };
}

/** The token holder appends a block signed by a third party. */
export function appendThirdParty(
  tokenBytes: Uint8Array,
  response: ThirdPartyResponse,
  options: BuildOptions = {},
): Uint8Array {
  const token = decodeBiscuit(tokenBytes);
  if (token.proof.kind !== "nextSecret")
    throw new BuilderError("the token is sealed and cannot be attenuated");
  const previous = token.blocks.length ? token.blocks[token.blocks.length - 1] : token.authority;

  const algorithm = options.algorithm ?? 0;
  const next = options.nextKeypair ?? generateKeypair(algorithm);
  const nextKey: PublicKeyMsg = { algorithm, key: next.publicKey };
  const payload = blockPayloadV1(
    response.block,
    nextKey,
    response.signature,
    previous.signature,
    SIGNATURE_VERSION,
  );
  const signature = sign(payload, token.proof.value, previous.nextKey.algorithm);

  token.blocks.push({
    block: response.block,
    nextKey,
    signature,
    externalSignature: { signature: response.signature, publicKey: response.publicKey },
    version: SIGNATURE_VERSION,
  });
  token.proof = { kind: "nextSecret", value: next.secretKey };
  return encodeBiscuit(token);
}
