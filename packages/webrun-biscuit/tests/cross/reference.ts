/**
 * Loads the **reference implementation** — the Rust `biscuit-auth` crate
 * compiled to WebAssembly and published as `@biscuit-auth/biscuit-wasm`.
 *
 * The package targets bundlers, so its entry point uses a bare
 * `import ... from './biscuit_bg.wasm'` that Node cannot resolve. We
 * instantiate the module by hand instead: read the `.wasm`, and satisfy its
 * imports with the wasm-bindgen glue module plus each of the inline JS
 * snippets it was compiled with.
 *
 * This is the reference implementation's own code, not a reimplementation of
 * it — which is the point: these tests are only meaningful if the other side
 * of the comparison is genuinely upstream.
 */
import fs from "node:fs";
import path from "node:path";
export interface Reference {
  KeyPair: any;
  PrivateKey: any;
  PublicKey: any;
  Biscuit: any;
  BiscuitBuilder: any;
  BlockBuilder: any;
  AuthorizerBuilder: any;
  Fact: any;
  Rule: any;
  Check: any;
  Policy: any;
  SignatureAlgorithm: any;
  version: string;
}

let cached: Reference | null | undefined;

function findPackageDir(): string | null {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "node_modules", "@biscuit-auth", "biscuit-wasm");
    if (fs.existsSync(path.join(candidate, "module", "biscuit_bg.wasm"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Returns the reference implementation, or null when it is not installed. */
export async function loadReference(): Promise<Reference | null> {
  if (cached !== undefined) return cached;

  // The package declares `exports: { import: './module/biscuit.js' }`, which
  // Node's CJS resolver rejects and whose ESM entry point imports the .wasm
  // file directly. Neither resolver gets us what we need, so find the package
  // directory by walking up from here.
  const packageDir = findPackageDir();
  if (packageDir === null) {
    cached = null;
    return cached;
  }
  const moduleDir = path.join(packageDir, "module");

  const glue = await import(path.join(moduleDir, "biscuit_bg.js"));

  // every `snippets/<hash>/inline0.js` is an import the wasm module expects,
  // keyed by its path relative to the glue module
  const imports: Record<string, unknown> = { "./biscuit_bg.js": glue };
  const snippetsDir = path.join(moduleDir, "snippets");
  if (fs.existsSync(snippetsDir)) {
    for (const hash of fs.readdirSync(snippetsDir)) {
      for (const file of fs.readdirSync(path.join(snippetsDir, hash))) {
        const key = `./snippets/${hash}/${file}`;
        imports[key] = await import(path.join(snippetsDir, hash, file));
      }
    }
  }

  const bytes = fs.readFileSync(path.join(moduleDir, "biscuit_bg.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes, imports as WebAssembly.Imports);
  glue.__wbg_set_wasm(instance.exports);
  (instance.exports as any).__wbindgen_start?.();

  const version = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ).version;

  cached = { ...(glue as any), version } as Reference;
  return cached;
}

/* --------------------------------------------------------------- helpers */

/** Feed a block of Datalog source to a reference builder, statement by
 *  statement — the WASM API takes typed objects, not a source blob. */
export function addCode(ref: Reference, builder: any, code: string): void {
  for (const statement of splitStatements(code)) {
    if (/^check\s|^reject\s/.test(statement)) builder.addCheck(ref.Check.fromString(statement));
    else if (/^allow\s|^deny\s/.test(statement))
      builder.addPolicy(ref.Policy.fromString(statement));
    else if (statement.includes("<-")) builder.addRule(ref.Rule.fromString(statement));
    else builder.addFact(ref.Fact.fromString(statement));
  }
}

/** split on `;` at depth zero, ignoring separators inside strings or brackets */
export function splitStatements(code: string): string[] {
  const out: string[] = [];
  let current = "";
  let inString = false;
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (inString) {
      current += c;
      if (c === "\\") current += code[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === "[" || c === "{" || c === "(") depth++;
    if (c === "]" || c === "}" || c === ")") depth--;
    if (c === ";" && depth === 0) {
      const trimmed = strip(current);
      if (trimmed) out.push(trimmed);
      current = "";
      continue;
    }
    current += c;
  }
  const last = strip(current);
  if (last) out.push(last);
  return out;
}

const strip = (s: string): string =>
  s
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .trim();

export interface Outcome {
  kind: "ok" | "unauthorized" | "noMatchingPolicy" | "format" | "other";
  policy?: number;
  checks?: { source: "authorizer" | "block"; blockId?: number; checkId: number }[];
  detail?: string;
}

/** The reference throws structured objects, in the same shape `samples.json`
 *  records — so its outcomes can be compared field by field with ours. */
export function referenceOutcome(authorizer: any): Outcome {
  // The first `authorize` call on a given Authorizer reports a RunLimit
  // timeout even with a 60s budget, while every later call on the same object
  // returns instantly — the WASM build's clock misreads its first interval.
  // Retry rather than record a spurious mismatch; a genuine timeout still
  // fails on the retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { kind: "ok", policy: authorizer.authorizeWithLimits(runLimits()) };
    } catch (thrown) {
      const outcome = normalizeError(thrown);
      if (outcome.detail?.includes("RunLimit") && attempt < 2) continue;
      return outcome;
    }
  }
  return { kind: "other", detail: "unreachable" };
}

/**
 * The reference's default time limit is 1ms, which a cold WASM instance
 * routinely exceeds, so every call passes explicit limits.
 *
 * `max_time` is a serde `Duration` — `{ secs, nanos }`. Passing a plain number
 * of nanoseconds does not error: deserialization fails quietly and the
 * *default* limits are used instead, which then times out. That failure mode
 * is worth knowing about; it looks exactly like a slow engine.
 */
export const runLimits = () => ({
  max_facts: 1000,
  max_iterations: 100,
  max_time: { secs: 60, nanos: 0 },
});

export function normalizeError(thrown: unknown): Outcome {
  const e = thrown as any;
  const logic = e?.FailedLogic;
  if (logic?.Unauthorized)
    return { kind: "unauthorized", checks: normalizeChecks(logic.Unauthorized.checks ?? []) };
  if (logic?.NoMatchingPolicy)
    return {
      kind: "noMatchingPolicy",
      checks: normalizeChecks(logic.NoMatchingPolicy.checks ?? []),
    };
  if (e?.Format) return { kind: "format", detail: JSON.stringify(e) };
  return { kind: "other", detail: typeof e === "object" ? JSON.stringify(e) : String(e) };
}

const normalizeChecks = (checks: any[]): Outcome["checks"] =>
  checks.map((c) =>
    "Block" in c
      ? { source: "block" as const, blockId: c.Block.block_id, checkId: c.Block.check_id }
      : { source: "authorizer" as const, checkId: c.Authorizer.check_id },
  );
