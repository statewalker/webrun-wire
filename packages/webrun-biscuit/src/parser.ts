/**
 * Parser for the Biscuit Datalog text syntax (SPECIFICATIONS.md grammar).
 * Hand-written recursive descent + precedence climbing; expressions are
 * compiled straight to the opcode form the VM executes.
 */
import {
  BinaryOp as B,
  type Check,
  type CheckKind,
  type Fact,
  type MapKey,
  normalizeSet,
  type Op,
  type Predicate,
  type Rule,
  type Scope,
  type Term,
  UnaryOp as U,
} from "./datalog.js";

export class ParseError extends Error {}

/**
 * A value bound to a `{name}` parameter. It becomes a TERM, never source text,
 * so no string can change the shape of the program it is bound into.
 */
export type ParamValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Uint8Array
  | readonly ParamValue[]
  | ReadonlySet<ParamValue>;

export type Params = Readonly<Record<string, ParamValue>>;

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function paramTerm(name: string, value: ParamValue): Term {
  if (typeof value === "string") return { t: "str", v: value };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (value === null) return { t: "null" };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new ParseError(`parameter {${name}}: ${value} is not a safe integer`);
    return { t: "int", v: BigInt(value) };
  }
  if (typeof value === "bigint") {
    if (value < I64_MIN || value > I64_MAX)
      throw new ParseError(`parameter {${name}}: ${value} does not fit in i64`);
    return { t: "int", v: value };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new ParseError(`parameter {${name}}: invalid date`);
    return { t: "date", v: BigInt(Math.floor(ms / 1000)) };
  }
  if (value instanceof Uint8Array) return { t: "bytes", v: value };
  if (Array.isArray(value)) return { t: "array", v: value.map((x) => paramTerm(name, x)) };
  if (value instanceof Set)
    return { t: "set", v: normalizeSet([...value].map((x) => paramTerm(name, x))) };
  throw new ParseError(`parameter {${name}}: no Datalog term for this value`);
}

/** `{name}` in term position; `{true}`, `{false}` and `{null}` stay one-element sets */
const PARAMETER = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/;

export type Statement =
  | { k: "fact"; fact: Fact }
  | { k: "rule"; rule: Rule }
  | { k: "check"; check: Check }
  | { k: "policy"; kind: "allow" | "deny"; queries: Rule[] }
  | { k: "blockScope"; scopes: Scope[] };

/**
 * A predicate or variable name is one or more of `[A-Za-z0-9_:]`, and any of them
 * may come first — ASCII only. That is what the reference parser accepts, measured
 * rather than read from the specification (`tests/grammar-cases.ts`): `_m`, `1a`
 * and `::` are names, `ärger` is not.
 */
const NAME_CHAR = /[A-Za-z0-9_:]/;

export class Parser {
  private i = 0;
  private readonly vars: Map<string, number>;
  private readonly usedParams = new Set<string>();
  constructor(
    private readonly src: string,
    vars?: Map<string, number>,
    private readonly params: Params = {},
  ) {
    this.vars = vars ?? new Map();
  }

  /** names in `params` that the source never referred to */
  unusedParameters(): string[] {
    return Object.keys(this.params).filter((name) => !this.usedParams.has(name));
  }

  /** id -> name, for printing rules back out */
  variableNames(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [name, id] of this.vars) out.set(id, name);
    return out;
  }

  varId(name: string): number {
    let id = this.vars.get(name);
    if (id === undefined) {
      id = this.vars.size + 1;
      this.vars.set(name, id);
    }
    return id;
  }

  /* ---------------------------------------------------------- lexing utils */

  private ws(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
      if (this.src.startsWith("//", this.i)) {
        const nl = this.src.indexOf("\n", this.i);
        this.i = nl === -1 ? this.src.length : nl + 1;
        continue;
      }
      if (this.src.startsWith("/*", this.i)) {
        const end = this.src.indexOf("*/", this.i);
        this.i = end === -1 ? this.src.length : end + 2;
        continue;
      }
      return;
    }
  }
  private get eof(): boolean {
    this.ws();
    return this.i >= this.src.length;
  }
  private peek(s: string): boolean {
    this.ws();
    return this.src.startsWith(s, this.i);
  }
  private eat(s: string): boolean {
    if (!this.peek(s)) return false;
    this.i += s.length;
    return true;
  }
  private expect(s: string): void {
    if (!this.eat(s)) throw new ParseError(`expected "${s}" at offset ${this.i}`);
  }
  /** keyword: matches only if not followed by a name character */
  private keyword(k: string): boolean {
    this.ws();
    if (!this.src.startsWith(k, this.i)) return false;
    const after = this.src[this.i + k.length];
    if (after !== undefined && NAME_CHAR.test(after)) return false;
    this.i += k.length;
    return true;
  }
  /** the name directly after `$` — `$ x` is not a variable, as in the reference */
  private variableName(): string {
    const start = this.i;
    while (this.i < this.src.length && NAME_CHAR.test(this.src[this.i])) this.i++;
    if (this.i === start) throw new ParseError(`expected a variable name at offset ${this.i}`);
    return this.src.slice(start, this.i);
  }

  private name(): string {
    this.ws();
    const start = this.i;
    while (this.i < this.src.length && NAME_CHAR.test(this.src[this.i])) this.i++;
    if (this.i === start) throw new ParseError(`expected a name at offset ${this.i}`);
    return this.src.slice(start, this.i);
  }

  /* ----------------------------------------------------------------- terms */

  private string(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      if (this.i >= this.src.length) throw new ParseError("unterminated string");
      const c = this.src[this.i++];
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.src[this.i++];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === "0") out += "\0";
      else if (e === '"') out += '"';
      else if (e === "\\") out += "\\";
      else if (e === "u") {
        const m = /^\{([0-9a-fA-F]+)\}/.exec(this.src.slice(this.i));
        if (m) {
          out += String.fromCodePoint(parseInt(m[1], 16));
          this.i += m[0].length;
        } else {
          out += String.fromCharCode(parseInt(this.src.substr(this.i, 4), 16));
          this.i += 4;
        }
      } else out += e;
    }
  }

  private tryDate(): bigint | null {
    this.ws();
    const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/.exec(
      this.src.slice(this.i),
    );
    if (!m) return null;
    const ms = Date.parse(m[0]);
    if (Number.isNaN(ms)) throw new ParseError(`invalid date ${m[0]}`);
    this.i += m[0].length;
    return BigInt(Math.floor(ms / 1000));
  }

  /** a term that may be a variable (rule/check context) */
  term(allowVariables = true): Term {
    this.ws();
    const date = this.tryDate();
    if (date !== null) return { t: "date", v: date };

    if (this.peek('"')) return { t: "str", v: this.string() };
    if (this.eat("$")) {
      if (!allowVariables) throw new ParseError("variables are not allowed in facts");
      return { t: "var", v: this.varId(this.variableName()) };
    }
    if (this.keyword("true")) return { t: "bool", v: true };
    if (this.keyword("false")) return { t: "bool", v: false };
    if (this.keyword("null")) return { t: "null" };
    if (this.peek("hex:")) {
      this.i += 4;
      const start = this.i;
      while (this.i < this.src.length && /[0-9a-fA-F]/.test(this.src[this.i])) this.i++;
      const h = this.src.slice(start, this.i);
      if (h.length % 2) throw new ParseError("odd-length hex literal");
      const bytes = new Uint8Array(h.length / 2);
      for (let j = 0; j < bytes.length; j++) bytes[j] = parseInt(h.substr(j * 2, 2), 16);
      return { t: "bytes", v: bytes };
    }
    if (this.peek("[")) return this.array(allowVariables);
    if (this.peek("{")) return this.parameter() ?? this.setOrMap(allowVariables);

    const m = /^-?\d+/.exec(this.src.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return { t: "int", v: BigInt(m[0]) };
    }
    throw new ParseError(
      `unexpected term at offset ${this.i}: ${this.src.slice(this.i, this.i + 20)}`,
    );
  }

  private parameter(): Term | null {
    const m = PARAMETER.exec(this.src.slice(this.i));
    if (!m || m[1] === "true" || m[1] === "false" || m[1] === "null") return null;
    const name = m[1];
    if (!Object.hasOwn(this.params, name)) throw new ParseError(`unbound parameter {${name}}`);
    this.i += m[0].length;
    this.usedParams.add(name);
    return paramTerm(name, this.params[name]);
  }

  private array(allowVariables: boolean): Term {
    this.expect("[");
    const items: Term[] = [];
    if (this.eat("]")) return { t: "array", v: items };
    do {
      items.push(this.term(allowVariables));
    } while (this.eat(","));
    this.expect("]");
    return { t: "array", v: items };
  }

  private setOrMap(allowVariables: boolean): Term {
    this.expect("{");
    if (this.eat(",")) {
      this.expect("}");
      return { t: "set", v: [] }; // {,} is the empty set
    }
    if (this.eat("}")) return { t: "map", v: [] }; // {} is the empty map
    const first = this.term(allowVariables);
    if (this.eat(":")) {
      const entries: [MapKey, Term][] = [[this.asMapKey(first), this.term(allowVariables)]];
      while (this.eat(",")) {
        if (this.peek("}")) break;
        const k = this.asMapKey(this.term(allowVariables));
        this.expect(":");
        entries.push([k, this.term(allowVariables)]);
      }
      this.expect("}");
      return { t: "map", v: entries };
    }
    const items = [first];
    while (this.eat(",")) {
      if (this.peek("}")) break;
      items.push(this.term(allowVariables));
    }
    this.expect("}");
    return { t: "set", v: normalizeSet(items) };
  }

  private asMapKey(t: Term): MapKey {
    if (t.t === "int") return { t: "int", v: t.v };
    if (t.t === "str") return { t: "str", v: t.v };
    throw new ParseError("map keys must be integers or strings");
  }

  /* ------------------------------------------------------------ predicates */

  predicate(allowVariables = true): Predicate {
    const name = this.name();
    this.expect("(");
    // at least one term, as in the reference: `f()` is not a predicate
    if (this.peek(")")) throw new ParseError(`predicate ${name} takes at least one term`);
    const terms: Term[] = [];
    do {
      terms.push(this.term(allowVariables));
    } while (this.eat(","));
    this.expect(")");
    return { name, terms };
  }

  /* ----------------------------------------------------------- expressions */

  /** precedence climbing; each level returns opcodes in postfix order */
  expression(): Op[] {
    return this.orExpr();
  }

  private orExpr(): Op[] {
    let left = this.andExpr();
    while (this.peek("||")) {
      this.i += 2;
      const right = this.andExpr();
      left = [
        ...left,
        { kind: "closure", params: [], ops: right },
        { kind: "binary", op: B.LazyOr },
      ];
    }
    return left;
  }

  private andExpr(): Op[] {
    let left = this.comparison();
    while (this.peek("&&")) {
      this.i += 2;
      const right = this.comparison();
      left = [
        ...left,
        { kind: "closure", params: [], ops: right },
        { kind: "binary", op: B.LazyAnd },
      ];
    }
    return left;
  }

  private comparison(): Op[] {
    const left = this.bitXor();
    // comparison operators are non-associative
    for (const [tok, op] of [
      ["<=", B.LessOrEqual],
      [">=", B.GreaterOrEqual],
      ["===", B.Equal],
      ["!==", B.NotEqual],
      ["==", B.HeterogeneousEqual],
      ["!=", B.HeterogeneousNotEqual],
      ["<", B.LessThan],
      [">", B.GreaterThan],
    ] as [string, number][]) {
      if (this.peekOperator(tok)) {
        this.i += tok.length;
        const right = this.bitXor();
        return [...left, ...right, { kind: "binary", op }];
      }
    }
    return left;
  }

  /** avoids matching "==" when the source really has "===" */
  private peekOperator(tok: string): boolean {
    this.ws();
    if (!this.src.startsWith(tok, this.i)) return false;
    const next = this.src[this.i + tok.length];
    if ((tok === "==" || tok === "!=") && next === "=") return false;
    if ((tok === "<" || tok === ">") && next === "=") return false;
    return true;
  }

  private bitXor(): Op[] {
    let left = this.bitOr();
    while (this.peekOperator("^")) {
      this.i += 1;
      left = [...left, ...this.bitOr(), { kind: "binary", op: B.BitwiseXor }];
    }
    return left;
  }
  private bitOr(): Op[] {
    let left = this.bitAnd();
    while (this.peek("|") && !this.peek("||")) {
      this.i += 1;
      left = [...left, ...this.bitAnd(), { kind: "binary", op: B.BitwiseOr }];
    }
    return left;
  }
  private bitAnd(): Op[] {
    let left = this.additive();
    while (this.peek("&") && !this.peek("&&")) {
      this.i += 1;
      left = [...left, ...this.additive(), { kind: "binary", op: B.BitwiseAnd }];
    }
    return left;
  }
  private additive(): Op[] {
    let left = this.multiplicative();
    for (;;) {
      if (this.peekSign("+")) {
        this.i += 1;
        left = [...left, ...this.multiplicative(), { kind: "binary", op: B.Add }];
      } else if (this.peekSign("-")) {
        this.i += 1;
        left = [...left, ...this.multiplicative(), { kind: "binary", op: B.Sub }];
      } else return left;
    }
  }
  /** `-` starts a negative literal only when it is not an infix position */
  private peekSign(tok: string): boolean {
    this.ws();
    return this.src.startsWith(tok, this.i);
  }
  private multiplicative(): Op[] {
    let left = this.unary();
    for (;;) {
      if (this.peek("*")) {
        this.i += 1;
        left = [...left, ...this.unary(), { kind: "binary", op: B.Mul }];
      } else if (this.peek("/")) {
        this.i += 1;
        left = [...left, ...this.unary(), { kind: "binary", op: B.Div }];
      } else return left;
    }
  }

  private unary(): Op[] {
    if (this.eat("!")) {
      const inner = this.unary();
      return [...inner, { kind: "unary", op: U.Negate }];
    }
    return this.methods(this.primary());
  }

  private primary(): Op[] {
    this.ws();
    if (this.peek("(")) {
      this.i += 1;
      const inner = this.expression();
      this.expect(")");
      return inner;
    }
    return [{ kind: "value", value: this.term() }];
  }

  private methods(target: Op[]): Op[] {
    let out = target;
    while (this.peek(".")) {
      this.i += 1;
      if (this.peek("extern::")) {
        this.i += 8;
        const fn = this.name();
        this.expect("(");
        if (this.eat(")")) out = [...out, { kind: "unary", op: U.Ffi, ffi: fn }];
        else {
          const arg = this.expression();
          this.expect(")");
          out = [...out, ...arg, { kind: "binary", op: B.Ffi, ffi: fn }];
        }
        continue;
      }
      const method = this.name();
      this.expect("(");
      switch (method) {
        case "length":
          this.expect(")");
          out = [...out, { kind: "unary", op: U.Length }];
          break;
        case "type":
          this.expect(")");
          out = [...out, { kind: "unary", op: U.TypeOf }];
          break;
        case "any":
        case "all": {
          const closure = this.closure();
          this.expect(")");
          out = [...out, closure, { kind: "binary", op: method === "any" ? B.Any : B.All }];
          break;
        }
        case "try_or": {
          const fallback = this.expression();
          this.expect(")");
          // X.try_or(Y) => [closure(X), Y, TryOr] : the closure is what gets tried
          out = [
            { kind: "closure", params: [], ops: out },
            ...fallback,
            { kind: "binary", op: B.TryOr },
          ];
          break;
        }
        default: {
          const arg = this.expression();
          this.expect(")");
          const op = {
            contains: B.Contains,
            starts_with: B.Prefix,
            ends_with: B.Suffix,
            matches: B.Regex,
            intersection: B.Intersection,
            union: B.Union,
            get: B.Get,
          }[method];
          if (op === undefined) throw new ParseError(`unknown method ${method}`);
          out = [...out, ...arg, { kind: "binary", op }];
        }
      }
    }
    return out;
  }

  private closure(): Op {
    const params: number[] = [];
    this.ws();
    if (this.eat("(")) {
      this.expect(")");
    } else {
      do {
        this.expect("$");
        params.push(this.varId(this.variableName()));
      } while (this.eat(","));
    }
    this.expect("->");
    return { kind: "closure", params, ops: this.expression() };
  }

  /* ---------------------------------------------------------------- scopes */

  private scopes(): Scope[] {
    const out: Scope[] = [];
    do {
      this.ws();
      if (this.keyword("authority")) out.push({ kind: "authority" });
      else if (this.keyword("previous")) out.push({ kind: "previous" });
      else {
        const alg = this.name();
        this.expect("/");
        const start = this.i;
        while (this.i < this.src.length && /[0-9a-fA-F]/.test(this.src[this.i])) this.i++;
        out.push({
          kind: "publicKey",
          key: `${alg}/${this.src.slice(start, this.i).toLowerCase()}`,
        });
      }
    } while (this.eat(","));
    return out;
  }

  /* ------------------------------------------------------------ statements */

  /** body of a rule / check / policy: predicates, expressions, trusting */
  private ruleBody(): { body: Predicate[]; expressions: Op[][]; scopes: Scope[] } {
    const body: Predicate[] = [];
    const expressions: Op[][] = [];
    let scopes: Scope[] = [];
    do {
      this.ws();
      if (this.keyword("trusting")) {
        scopes = this.scopes();
        break;
      }
      const save = this.i;
      const asPredicate = this.tryPredicate();
      if (asPredicate) body.push(asPredicate);
      else {
        this.i = save;
        expressions.push(this.expression());
      }
      this.ws();
      if (this.keyword("trusting")) {
        scopes = this.scopes();
        break;
      }
    } while (this.eat(","));
    return { body, expressions, scopes };
  }

  /** a predicate is only a predicate if nothing operator-like follows it */
  private tryPredicate(): Predicate | null {
    const save = this.i;
    try {
      this.ws();
      if (!NAME_CHAR.test(this.src[this.i] ?? "")) return null;
      const p = this.predicate();
      this.ws();
      const rest = this.src.slice(this.i);
      if (rest === "" || /^[,;)]/.test(rest) || /^(or|trusting)\b/.test(rest)) return p;
      this.i = save;
      return null;
    } catch {
      this.i = save;
      return null;
    }
  }

  private queries(): Rule[] {
    const out: Rule[] = [];
    do {
      const { body, expressions, scopes } = this.ruleBody();
      out.push({ head: { name: "query", terms: [] }, body, expressions, scopes });
    } while (this.keyword("or"));
    return out;
  }

  statement(): Statement {
    this.ws();
    if (this.keyword("check")) {
      let kind: CheckKind;
      if (this.keyword("if")) kind = "one";
      else if (this.keyword("all")) kind = "all";
      else throw new ParseError('expected "if" or "all" after "check"');
      return { k: "check", check: { queries: this.queries(), kind } };
    }
    if (this.keyword("reject")) {
      if (!this.keyword("if")) throw new ParseError('expected "if" after "reject"');
      return { k: "check", check: { queries: this.queries(), kind: "reject" } };
    }
    if (this.keyword("allow")) {
      if (!this.keyword("if")) throw new ParseError('expected "if" after "allow"');
      return { k: "policy", kind: "allow", queries: this.queries() };
    }
    if (this.keyword("deny")) {
      if (!this.keyword("if")) throw new ParseError('expected "if" after "deny"');
      return { k: "policy", kind: "deny", queries: this.queries() };
    }
    if (this.keyword("trusting")) return { k: "blockScope", scopes: this.scopes() };

    const head = this.predicate();
    this.ws();
    if (this.eat("<-")) {
      const { body, expressions, scopes } = this.ruleBody();
      return { k: "rule", rule: { head, body, expressions, scopes } };
    }
    if (head.terms.some((t) => t.t === "var"))
      throw new ParseError("a fact cannot contain variables");
    return { k: "fact", fact: { predicate: head } };
  }

  parse(): Statement[] {
    const out: Statement[] = [];
    while (!this.eof) {
      out.push(this.statement());
      this.ws();
      this.expect(";");
    }
    return out;
  }
}

export const parse = (src: string, params?: Params): Statement[] =>
  new Parser(src, undefined, params).parse();
