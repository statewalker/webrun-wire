/**
 * Strict proto2 codec for the Biscuit schema.
 *
 * Written against src/schema.proto. Unlike a generated codec it: decodes
 * int64/uint64 as BigInt, tracks proto2 `optional` presence, validates UTF-8
 * strictly, and rejects unknown fields, wrong wire types and missing
 * `required` fields.
 */

export class ProtoError extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf8enc = new TextEncoder();

/* ------------------------------------------------------------------ reader */

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    pos = 0,
    readonly end = buf.length,
  ) {
    this.pos = pos;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  byte(): number {
    if (this.pos >= this.end) throw new ProtoError("unexpected end of buffer");
    return this.buf[this.pos++];
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      if (shift > 63n) throw new ProtoError("varint overflow");
      b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    return BigInt.asUintN(64, result);
  }
  varintNum(): number {
    const v = this.varint();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtoError("varint too large for a number");
    return Number(v);
  }
  bytes(): Uint8Array {
    const len = this.varintNum();
    if (this.pos + len > this.end) throw new ProtoError("length-delimited field overruns buffer");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  string(): string {
    try {
      return utf8.decode(this.bytes());
    } catch {
      throw new ProtoError("invalid UTF-8 in string field");
    }
  }
  sub(): Reader {
    const b = this.bytes();
    return new Reader(b, 0, b.length);
  }
}

type FieldHandler = (field: number, wire: number, r: Reader) => void;

function readFields(r: Reader, handler: FieldHandler): void {
  while (!r.done) {
    const tag = r.varintNum();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 0) throw new ProtoError("invalid field number 0");
    handler(field, wire, r);
  }
}

function expect(wire: number, want: number, field: number): void {
  if (wire !== want) throw new ProtoError(`wrong wire type ${wire} for field ${field}`);
}

function required<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new ProtoError(`missing required field ${name}`);
  return v;
}

/* ------------------------------------------------------------------ writer */

class Writer {
  private buf = new Uint8Array(256);
  private pos = 0;
  private grow(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let len = this.buf.length;
    while (len < this.pos + n) len *= 2;
    const next = new Uint8Array(len);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  varint(v: bigint | number): void {
    let x = BigInt.asUintN(64, BigInt(v));
    this.grow(10);
    do {
      let b = Number(x & 0x7fn);
      x >>= 7n;
      if (x) b |= 0x80;
      this.buf[this.pos++] = b;
    } while (x);
  }
  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }
  varintField(field: number, v: bigint | number): void {
    this.tag(field, 0);
    this.varint(v);
  }
  bytesField(field: number, v: Uint8Array): void {
    this.tag(field, 2);
    this.varint(v.length);
    this.grow(v.length);
    this.buf.set(v, this.pos);
    this.pos += v.length;
  }
  stringField(field: number, v: string): void {
    this.bytesField(field, utf8enc.encode(v));
  }
  messageField<T>(field: number, write: (v: T, w: Writer) => void, v: T): void {
    const w = new Writer();
    write(v, w);
    this.bytesField(field, w.finish());
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/* ------------------------------------------------------------------- types */

export type Algorithm = 0 | 1; // Ed25519 | SECP256R1

export interface PublicKeyMsg {
  algorithm: Algorithm;
  key: Uint8Array;
}
export interface ExternalSignature {
  signature: Uint8Array;
  publicKey: PublicKeyMsg;
}
export interface SignedBlock {
  block: Uint8Array;
  nextKey: PublicKeyMsg;
  signature: Uint8Array;
  externalSignature?: ExternalSignature;
  version?: number;
}
export type Proof =
  | { kind: "nextSecret"; value: Uint8Array }
  | { kind: "finalSignature"; value: Uint8Array };

export interface BiscuitMsg {
  rootKeyId?: number;
  authority: SignedBlock;
  blocks: SignedBlock[];
  proof: Proof;
}

export type TermMsg =
  | { kind: "variable"; value: number }
  | { kind: "integer"; value: bigint }
  | { kind: "string"; value: number }
  | { kind: "date"; value: bigint }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "bool"; value: boolean }
  | { kind: "set"; value: TermMsg[] }
  | { kind: "null" }
  | { kind: "array"; value: TermMsg[] }
  | { kind: "map"; value: MapEntryMsg[] };

export type MapKeyMsg = { kind: "integer"; value: bigint } | { kind: "string"; value: number };
export interface MapEntryMsg {
  key: MapKeyMsg;
  value: TermMsg;
}

export type OpMsg =
  | { kind: "value"; value: TermMsg }
  | { kind: "unary"; op: number; ffiName?: number }
  | { kind: "binary"; op: number; ffiName?: number }
  | { kind: "closure"; params: number[]; ops: OpMsg[] };

export interface PredicateMsg {
  name: number;
  terms: TermMsg[];
}
export type ScopeMsg = { kind: "type"; value: 0 | 1 } | { kind: "publicKey"; value: number };
export interface RuleMsg {
  head: PredicateMsg;
  body: PredicateMsg[];
  expressions: OpMsg[][];
  scope: ScopeMsg[];
}
export interface CheckMsg {
  queries: RuleMsg[];
  kind?: 0 | 1 | 2; // One | All | Reject
}
export interface BlockMsg {
  symbols: string[];
  context?: string;
  version?: number;
  facts: PredicateMsg[];
  rules: RuleMsg[];
  checks: CheckMsg[];
  scope: ScopeMsg[];
  publicKeys: PublicKeyMsg[];
}

/* ------------------------------------------------------------------ decode */

function readPublicKey(r: Reader): PublicKeyMsg {
  let algorithm: number | undefined;
  let key: Uint8Array | undefined;
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 0, f);
      algorithm = rr.varintNum();
    } else if (f === 2) {
      expect(w, 2, f);
      key = rr.bytes();
    } else throw new ProtoError(`unknown field ${f} in PublicKey`);
  });
  const alg = required(algorithm, "PublicKey.algorithm");
  if (alg !== 0 && alg !== 1) throw new ProtoError(`unknown signature algorithm ${alg}`);
  return { algorithm: alg as Algorithm, key: required(key, "PublicKey.key") };
}

function readExternalSignature(r: Reader): ExternalSignature {
  let signature: Uint8Array | undefined;
  let publicKey: PublicKeyMsg | undefined;
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 2, f);
      signature = rr.bytes();
    } else if (f === 2) {
      expect(w, 2, f);
      publicKey = readPublicKey(rr.sub());
    } else throw new ProtoError(`unknown field ${f} in ExternalSignature`);
  });
  return {
    signature: required(signature, "ExternalSignature.signature"),
    publicKey: required(publicKey, "ExternalSignature.publicKey"),
  };
}

function readSignedBlock(r: Reader): SignedBlock {
  const out: Partial<SignedBlock> = {};
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 2, f);
      out.block = rr.bytes();
    } else if (f === 2) {
      expect(w, 2, f);
      out.nextKey = readPublicKey(rr.sub());
    } else if (f === 3) {
      expect(w, 2, f);
      out.signature = rr.bytes();
    } else if (f === 4) {
      expect(w, 2, f);
      out.externalSignature = readExternalSignature(rr.sub());
    } else if (f === 5) {
      expect(w, 0, f);
      out.version = rr.varintNum();
    } else throw new ProtoError(`unknown field ${f} in SignedBlock`);
  });
  return {
    block: required(out.block, "SignedBlock.block"),
    nextKey: required(out.nextKey, "SignedBlock.nextKey"),
    signature: required(out.signature, "SignedBlock.signature"),
    externalSignature: out.externalSignature,
    version: out.version,
  };
}

export function decodeBiscuit(buf: Uint8Array): BiscuitMsg {
  const r = new Reader(buf);
  let rootKeyId: number | undefined;
  let authority: SignedBlock | undefined;
  const blocks: SignedBlock[] = [];
  let proof: Proof | undefined;
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 0, f);
      rootKeyId = rr.varintNum();
    } else if (f === 2) {
      expect(w, 2, f);
      authority = readSignedBlock(rr.sub());
    } else if (f === 3) {
      expect(w, 2, f);
      blocks.push(readSignedBlock(rr.sub()));
    } else if (f === 4) {
      expect(w, 2, f);
      const p = rr.sub();
      readFields(p, (pf, pw, pr) => {
        if (pf === 1) {
          expect(pw, 2, pf);
          proof = { kind: "nextSecret", value: pr.bytes() };
        } else if (pf === 2) {
          expect(pw, 2, pf);
          proof = { kind: "finalSignature", value: pr.bytes() };
        } else throw new ProtoError(`unknown field ${pf} in Proof`);
      });
    } else throw new ProtoError(`unknown field ${f} in Biscuit`);
  });
  return {
    rootKeyId,
    authority: required(authority, "Biscuit.authority"),
    blocks,
    proof: required(proof, "Biscuit.proof"),
  };
}

function readTerm(r: Reader): TermMsg {
  let out: TermMsg | undefined;
  readFields(r, (f, w, rr) => {
    switch (f) {
      case 1:
        expect(w, 0, f);
        out = { kind: "variable", value: rr.varintNum() };
        break;
      case 2:
        expect(w, 0, f);
        out = { kind: "integer", value: BigInt.asIntN(64, rr.varint()) };
        break;
      case 3:
        expect(w, 0, f);
        out = { kind: "string", value: rr.varintNum() };
        break;
      case 4:
        expect(w, 0, f);
        out = { kind: "date", value: rr.varint() };
        break;
      case 5:
        expect(w, 2, f);
        out = { kind: "bytes", value: rr.bytes() };
        break;
      case 6: {
        expect(w, 0, f);
        const v = rr.varintNum();
        out = { kind: "bool", value: v !== 0 };
        break;
      }
      case 7: {
        expect(w, 2, f);
        const set: TermMsg[] = [];
        readFields(rr.sub(), (sf, sw, sr) => {
          if (sf !== 1) throw new ProtoError(`unknown field ${sf} in TermSet`);
          expect(sw, 2, sf);
          set.push(readTerm(sr.sub()));
        });
        out = { kind: "set", value: set };
        break;
      }
      case 8:
        expect(w, 2, f);
        rr.bytes();
        out = { kind: "null" };
        break;
      case 9: {
        expect(w, 2, f);
        const arr: TermMsg[] = [];
        readFields(rr.sub(), (af, aw, ar) => {
          if (af !== 1) throw new ProtoError(`unknown field ${af} in Array`);
          expect(aw, 2, af);
          arr.push(readTerm(ar.sub()));
        });
        out = { kind: "array", value: arr };
        break;
      }
      case 10: {
        expect(w, 2, f);
        const entries: MapEntryMsg[] = [];
        readFields(rr.sub(), (mf, mw, mr) => {
          if (mf !== 1) throw new ProtoError(`unknown field ${mf} in Map`);
          expect(mw, 2, mf);
          entries.push(readMapEntry(mr.sub()));
        });
        out = { kind: "map", value: entries };
        break;
      }
      default:
        throw new ProtoError(`unknown field ${f} in Term`);
    }
  });
  return required(out, "Term.Content");
}

function readMapEntry(r: Reader): MapEntryMsg {
  let key: MapKeyMsg | undefined;
  let value: TermMsg | undefined;
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 2, f);
      readFields(rr.sub(), (kf, kw, kr) => {
        if (kf === 1) {
          expect(kw, 0, kf);
          key = { kind: "integer", value: BigInt.asIntN(64, kr.varint()) };
        } else if (kf === 2) {
          expect(kw, 0, kf);
          key = { kind: "string", value: kr.varintNum() };
        } else throw new ProtoError(`unknown field ${kf} in MapKey`);
      });
    } else if (f === 2) {
      expect(w, 2, f);
      value = readTerm(rr.sub());
    } else throw new ProtoError(`unknown field ${f} in MapEntry`);
  });
  return { key: required(key, "MapEntry.key"), value: required(value, "MapEntry.value") };
}

function readPredicate(r: Reader): PredicateMsg {
  let name: number | undefined;
  const terms: TermMsg[] = [];
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 0, f);
      name = rr.varintNum();
    } else if (f === 2) {
      expect(w, 2, f);
      terms.push(readTerm(rr.sub()));
    } else throw new ProtoError(`unknown field ${f} in Predicate`);
  });
  return { name: required(name, "Predicate.name"), terms };
}

function readOp(r: Reader): OpMsg {
  let out: OpMsg | undefined;
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 2, f);
      out = { kind: "value", value: readTerm(rr.sub()) };
    } else if (f === 2 || f === 3) {
      expect(w, 2, f);
      let op: number | undefined;
      let ffiName: number | undefined;
      readFields(rr.sub(), (of_, ow, or_) => {
        if (of_ === 1) {
          expect(ow, 0, of_);
          op = or_.varintNum();
        } else if (of_ === 2) {
          expect(ow, 0, of_);
          ffiName = or_.varintNum();
        } else throw new ProtoError(`unknown field ${of_} in Op`);
      });
      out = { kind: f === 2 ? "unary" : "binary", op: required(op, "Op.kind"), ffiName };
    } else if (f === 4) {
      expect(w, 2, f);
      const params: number[] = [];
      const ops: OpMsg[] = [];
      readFields(rr.sub(), (cf, cw, cr) => {
        if (cf === 1) {
          if (cw === 0) params.push(cr.varintNum());
          else if (cw === 2) {
            const packed = cr.sub();
            while (!packed.done) params.push(packed.varintNum());
          } else throw new ProtoError("bad wire type for OpClosure.params");
        } else if (cf === 2) {
          expect(cw, 2, cf);
          ops.push(readOp(cr.sub()));
        } else throw new ProtoError(`unknown field ${cf} in OpClosure`);
      });
      out = { kind: "closure", params, ops };
    } else throw new ProtoError(`unknown field ${f} in Op`);
  });
  return required(out, "Op.Content");
}

function readScope(r: Reader): ScopeMsg {
  let out: ScopeMsg | undefined;
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 0, f);
      const v = rr.varintNum();
      if (v !== 0 && v !== 1) throw new ProtoError(`unknown scope type ${v}`);
      out = { kind: "type", value: v as 0 | 1 };
    } else if (f === 2) {
      expect(w, 0, f);
      out = { kind: "publicKey", value: Number(BigInt.asIntN(64, rr.varint())) };
    } else throw new ProtoError(`unknown field ${f} in Scope`);
  });
  return required(out, "Scope.Content");
}

function readRule(r: Reader): RuleMsg {
  let head: PredicateMsg | undefined;
  const body: PredicateMsg[] = [];
  const expressions: OpMsg[][] = [];
  const scope: ScopeMsg[] = [];
  readFields(r, (f, w, rr) => {
    if (f === 1) {
      expect(w, 2, f);
      head = readPredicate(rr.sub());
    } else if (f === 2) {
      expect(w, 2, f);
      body.push(readPredicate(rr.sub()));
    } else if (f === 3) {
      expect(w, 2, f);
      const ops: OpMsg[] = [];
      readFields(rr.sub(), (ef, ew, er) => {
        if (ef !== 1) throw new ProtoError(`unknown field ${ef} in Expression`);
        expect(ew, 2, ef);
        ops.push(readOp(er.sub()));
      });
      expressions.push(ops);
    } else if (f === 4) {
      expect(w, 2, f);
      scope.push(readScope(rr.sub()));
    } else throw new ProtoError(`unknown field ${f} in Rule`);
  });
  return { head: required(head, "Rule.head"), body, expressions, scope };
}

export function decodeBlock(buf: Uint8Array): BlockMsg {
  const out: BlockMsg = {
    symbols: [],
    facts: [],
    rules: [],
    checks: [],
    scope: [],
    publicKeys: [],
  };
  readFields(new Reader(buf), (f, w, rr) => {
    switch (f) {
      case 1:
        expect(w, 2, f);
        out.symbols.push(rr.string());
        break;
      case 2:
        expect(w, 2, f);
        out.context = rr.string();
        break;
      case 3:
        expect(w, 0, f);
        out.version = rr.varintNum();
        break;
      case 4: {
        expect(w, 2, f);
        let pred: PredicateMsg | undefined;
        readFields(rr.sub(), (ff, fw, fr) => {
          if (ff !== 1) throw new ProtoError(`unknown field ${ff} in Fact`);
          expect(fw, 2, ff);
          pred = readPredicate(fr.sub());
        });
        out.facts.push(required(pred, "Fact.predicate"));
        break;
      }
      case 5:
        expect(w, 2, f);
        out.rules.push(readRule(rr.sub()));
        break;
      case 6: {
        expect(w, 2, f);
        const queries: RuleMsg[] = [];
        let kind: number | undefined;
        readFields(rr.sub(), (cf, cw, cr) => {
          if (cf === 1) {
            expect(cw, 2, cf);
            queries.push(readRule(cr.sub()));
          } else if (cf === 2) {
            expect(cw, 0, cf);
            kind = cr.varintNum();
          } else throw new ProtoError(`unknown field ${cf} in Check`);
        });
        if (kind !== undefined && kind !== 0 && kind !== 1 && kind !== 2)
          throw new ProtoError(`unknown check kind ${kind}`);
        out.checks.push({ queries, kind: kind as 0 | 1 | 2 | undefined });
        break;
      }
      case 7:
        expect(w, 2, f);
        out.scope.push(readScope(rr.sub()));
        break;
      case 8:
        expect(w, 2, f);
        out.publicKeys.push(readPublicKey(rr.sub()));
        break;
      default:
        throw new ProtoError(`unknown field ${f} in Block`);
    }
  });
  return out;
}

/* ------------------------------------------------------------------ encode */

function writePublicKey(v: PublicKeyMsg, w: Writer): void {
  w.varintField(1, v.algorithm);
  w.bytesField(2, v.key);
}

function writeSignedBlock(v: SignedBlock, w: Writer): void {
  w.bytesField(1, v.block);
  w.messageField(2, writePublicKey, v.nextKey);
  w.bytesField(3, v.signature);
  if (v.externalSignature !== undefined)
    w.messageField(
      4,
      (e: ExternalSignature, ww: Writer) => {
        ww.bytesField(1, e.signature);
        ww.messageField(2, writePublicKey, e.publicKey);
      },
      v.externalSignature,
    );
  if (v.version !== undefined) w.varintField(5, v.version);
}

export function encodeBiscuit(v: BiscuitMsg): Uint8Array {
  const w = new Writer();
  if (v.rootKeyId !== undefined) w.varintField(1, v.rootKeyId);
  w.messageField(2, writeSignedBlock, v.authority);
  for (const b of v.blocks) w.messageField(3, writeSignedBlock, b);
  w.messageField(
    4,
    (p: Proof, ww: Writer) => ww.bytesField(p.kind === "nextSecret" ? 1 : 2, p.value),
    v.proof,
  );
  return w.finish();
}

function writeTerm(t: TermMsg, w: Writer): void {
  switch (t.kind) {
    case "variable":
      w.varintField(1, t.value);
      break;
    case "integer":
      w.varintField(2, t.value);
      break;
    case "string":
      w.varintField(3, t.value);
      break;
    case "date":
      w.varintField(4, t.value);
      break;
    case "bytes":
      w.bytesField(5, t.value);
      break;
    case "bool":
      w.varintField(6, t.value ? 1 : 0);
      break;
    case "set":
      w.messageField(
        7,
        (items: TermMsg[], ww: Writer) => {
          for (const i of items) ww.messageField(1, writeTerm, i);
        },
        t.value,
      );
      break;
    case "null":
      w.bytesField(8, new Uint8Array(0));
      break;
    case "array":
      w.messageField(
        9,
        (items: TermMsg[], ww: Writer) => {
          for (const i of items) ww.messageField(1, writeTerm, i);
        },
        t.value,
      );
      break;
    case "map":
      w.messageField(
        10,
        (entries: MapEntryMsg[], ww: Writer) => {
          for (const e of entries)
            ww.messageField(
              1,
              (en: MapEntryMsg, w3: Writer) => {
                w3.messageField(
                  1,
                  (k: MapKeyMsg, w4: Writer) =>
                    w4.varintField(k.kind === "integer" ? 1 : 2, k.value),
                  en.key,
                );
                w3.messageField(2, writeTerm, en.value);
              },
              e,
            );
        },
        t.value,
      );
      break;
  }
}

function writePredicate(p: PredicateMsg, w: Writer): void {
  w.varintField(1, p.name);
  for (const t of p.terms) w.messageField(2, writeTerm, t);
}

function writeOp(op: OpMsg, w: Writer): void {
  switch (op.kind) {
    case "value":
      w.messageField(1, writeTerm, op.value);
      break;
    case "unary":
    case "binary":
      w.messageField(
        op.kind === "unary" ? 2 : 3,
        (o: OpMsg & { op: number; ffiName?: number }, ww: Writer) => {
          ww.varintField(1, o.op);
          if (o.ffiName !== undefined) ww.varintField(2, o.ffiName);
        },
        op,
      );
      break;
    case "closure":
      w.messageField(
        4,
        (c: { params: number[]; ops: OpMsg[] }, ww: Writer) => {
          for (const p of c.params) ww.varintField(1, p);
          for (const o of c.ops) ww.messageField(2, writeOp, o);
        },
        op,
      );
      break;
  }
}

function writeScope(s: ScopeMsg, w: Writer): void {
  w.varintField(s.kind === "type" ? 1 : 2, s.value);
}

function writeRule(r: RuleMsg, w: Writer): void {
  w.messageField(1, writePredicate, r.head);
  for (const p of r.body) w.messageField(2, writePredicate, p);
  for (const e of r.expressions)
    w.messageField(
      3,
      (ops: OpMsg[], ww: Writer) => {
        for (const o of ops) ww.messageField(1, writeOp, o);
      },
      e,
    );
  for (const s of r.scope) w.messageField(4, writeScope, s);
}

export function encodeBlock(b: BlockMsg): Uint8Array {
  const w = new Writer();
  for (const s of b.symbols) w.stringField(1, s);
  if (b.context !== undefined) w.stringField(2, b.context);
  if (b.version !== undefined) w.varintField(3, b.version);
  for (const f of b.facts)
    w.messageField(4, (p: PredicateMsg, ww: Writer) => ww.messageField(1, writePredicate, p), f);
  for (const r of b.rules) w.messageField(5, writeRule, r);
  for (const c of b.checks)
    w.messageField(
      6,
      (ch: CheckMsg, ww: Writer) => {
        for (const q of ch.queries) ww.messageField(1, writeRule, q);
        if (ch.kind !== undefined) ww.varintField(2, ch.kind);
      },
      c,
    );
  for (const s of b.scope) w.messageField(7, writeScope, s);
  for (const k of b.publicKeys) w.messageField(8, writePublicKey, k);
  return w.finish();
}
