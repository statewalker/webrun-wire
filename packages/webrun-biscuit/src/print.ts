/** Datalog pretty-printer (used for error messages and world snapshots). */
import {
  BinaryOp as B,
  type Check,
  type MapKey,
  type Op,
  type Predicate,
  type Rule,
  type Scope,
  type Term,
  UnaryOp as U,
} from "./datalog.js";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Datalog string literal: only the quote and the backslash are escaped.
 *  Control characters are emitted raw, unlike JSON.stringify. */
const quote = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function printTerm(t: Term, varName: (id: number) => string): string {
  switch (t.t) {
    case "var":
      return `$${varName(t.v)}`;
    case "int":
      return t.v.toString();
    case "str":
      return quote(t.v);
    case "date":
      return new Date(Number(t.v) * 1000).toISOString().replace(".000Z", "Z");
    case "bytes":
      return `hex:${hex(t.v)}`;
    case "bool":
      return t.v ? "true" : "false";
    case "null":
      return "null";
    case "set":
      return t.v.length === 0 ? "{,}" : `{${t.v.map((x) => printTerm(x, varName)).join(", ")}}`;
    case "array":
      return `[${t.v.map((x) => printTerm(x, varName)).join(", ")}]`;
    case "map":
      return t.v.length === 0
        ? "{}"
        : `{${t.v.map(([k, v]: [MapKey, Term]) => `${k.t === "int" ? k.v : quote(k.v)}: ${printTerm(v, varName)}`).join(", ")}}`;
  }
}

export const printPredicate = (p: Predicate, varName: (id: number) => string): string =>
  `${p.name}(${p.terms.map((t) => printTerm(t, varName)).join(", ")})`;

const UNARY: Record<number, (a: string) => string> = {
  [U.Negate]: (a) => `!${a}`,
  [U.Parens]: (a) => `(${a})`,
  [U.Length]: (a) => `${a}.length()`,
  [U.TypeOf]: (a) => `${a}.type()`,
};
const BINARY: Record<number, (a: string, b: string) => string> = {
  [B.LessThan]: (a, b) => `${a} < ${b}`,
  [B.GreaterThan]: (a, b) => `${a} > ${b}`,
  [B.LessOrEqual]: (a, b) => `${a} <= ${b}`,
  [B.GreaterOrEqual]: (a, b) => `${a} >= ${b}`,
  [B.Equal]: (a, b) => `${a} === ${b}`,
  [B.NotEqual]: (a, b) => `${a} !== ${b}`,
  [B.HeterogeneousEqual]: (a, b) => `${a} == ${b}`,
  [B.HeterogeneousNotEqual]: (a, b) => `${a} != ${b}`,
  [B.Contains]: (a, b) => `${a}.contains(${b})`,
  [B.Prefix]: (a, b) => `${a}.starts_with(${b})`,
  [B.Suffix]: (a, b) => `${a}.ends_with(${b})`,
  [B.Regex]: (a, b) => `${a}.matches(${b})`,
  [B.Add]: (a, b) => `${a} + ${b}`,
  [B.Sub]: (a, b) => `${a} - ${b}`,
  [B.Mul]: (a, b) => `${a} * ${b}`,
  [B.Div]: (a, b) => `${a} / ${b}`,
  [B.And]: (a, b) => `${a} &&! ${b}`,
  [B.Or]: (a, b) => `${a} ||! ${b}`,
  [B.Intersection]: (a, b) => `${a}.intersection(${b})`,
  [B.Union]: (a, b) => `${a}.union(${b})`,
  [B.BitwiseAnd]: (a, b) => `${a} & ${b}`,
  [B.BitwiseOr]: (a, b) => `${a} | ${b}`,
  [B.BitwiseXor]: (a, b) => `${a} ^ ${b}`,
  [B.LazyAnd]: (a, b) => `${a} && ${b}`,
  [B.LazyOr]: (a, b) => `${a} || ${b}`,
  [B.All]: (a, b) => `${a}.all(${b})`,
  [B.Any]: (a, b) => `${a}.any(${b})`,
  [B.Get]: (a, b) => `${a}.get(${b})`,
  [B.TryOr]: (a, b) => `${a}.try_or(${b})`,
};

export function printExpression(ops: Op[], varName: (id: number) => string): string {
  const stack: string[] = [];
  for (const op of ops) {
    if (op.kind === "value") stack.push(printTerm(op.value, varName));
    else if (op.kind === "closure")
      stack.push(
        `${op.params.map((p) => `$${varName(p)}`).join(", ")}${op.params.length ? " -> " : ""}${printExpression(op.ops, varName)}`,
      );
    else if (op.kind === "unary") {
      const a = stack.pop() ?? "";
      stack.push(op.ffi ? `${a}.extern::${op.ffi}()` : (UNARY[op.op]?.(a) ?? a));
    } else {
      const b = stack.pop() ?? "";
      const a = stack.pop() ?? "";
      stack.push(
        op.ffi ? `${a}.extern::${op.ffi}(${b})` : (BINARY[op.op]?.(a, b) ?? `${a} ? ${b}`),
      );
    }
  }
  return stack.join(" ");
}

export function printScopes(scopes: Scope[]): string {
  if (scopes.length === 0) return "";
  const parts = scopes.map((s) =>
    s.kind === "authority" ? "authority" : s.kind === "previous" ? "previous" : s.key,
  );
  return ` trusting ${parts.join(", ")}`;
}

/** the body of a rule, check or policy: predicates, then expressions */
export function printQuery(r: Rule, varName: (id: number) => string): string {
  const parts = [
    ...r.body.map((p) => printPredicate(p, varName)),
    ...r.expressions.map((e) => printExpression(e, varName)),
  ];
  return parts.join(", ") + printScopes(r.scopes);
}

export function printCheck(c: Check, varName: (id: number) => string): string {
  const head = c.kind === "all" ? "check all " : c.kind === "reject" ? "reject if " : "check if ";
  return head + c.queries.map((q) => printQuery(q, varName)).join(" or ");
}

export function printPolicy(
  kind: "allow" | "deny",
  queries: Rule[],
  varName: (id: number) => string,
): string {
  return `${kind} if ` + queries.map((q) => printQuery(q, varName)).join(" or ");
}

export function printRule(r: Rule, varName: (id: number) => string): string {
  const parts = [
    ...r.body.map((p) => printPredicate(p, varName)),
    ...r.expressions.map((e) => printExpression(e, varName)),
  ];
  return `${printPredicate(r.head, varName)} <- ${parts.join(", ")}` + printScopes(r.scopes);
}
