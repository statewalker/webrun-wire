// Lex pass — discovery and inline rewriting of import specifiers.
// Built on top of `es-module-lexer`. Callers MUST `await init` once before
// using `discoverSpecifiers` or `rewriteImports`.

import { init, parse } from "es-module-lexer";

export { init };

/**
 * Return the deduplicated list of static import specifiers (and dynamic
 * `import("…")` specifiers that are a plain string literal) discovered in
 * the given module source. Dynamic imports with non-string arguments are
 * skipped — their `n` field is undefined and we can't statically rewrite
 * them anyway.
 */
export function discoverSpecifiers(code: string): string[] {
  const [imports] = parse(code);
  const out = new Set<string>();
  for (const imp of imports) {
    if (imp.n !== undefined) out.add(imp.n);
  }
  return [...out];
}

/**
 * Rewrite every static and resolvable-dynamic import specifier in `code`
 * by calling `mapSpecifier(raw)` for each one. If the mapper returns the
 * same string, the specifier is left untouched. Walks imports in reverse
 * order so positional rewrites don't invalidate later ranges.
 */
export function rewriteImports(code: string, mapSpecifier: (raw: string) => string): string {
  const [imports] = parse(code);
  let out = code;
  for (let i = imports.length - 1; i >= 0; i--) {
    const imp = imports[i];
    if (imp.n === undefined) continue;
    const replacement = mapSpecifier(imp.n);
    if (replacement === imp.n) continue;
    // For dynamic imports the lexer's s/e bounds include the surrounding
    // string quotes; for static imports they fall between the quotes.
    // Preserve the quote characters around the replacement in the
    // quote-inclusive case so the output remains syntactically valid.
    const startChar = out.charAt(imp.s);
    const isQuoted = startChar === '"' || startChar === "'" || startChar === "`";
    const finalRepl = isQuoted ? `${startChar}${replacement}${startChar}` : replacement;
    out = out.slice(0, imp.s) + finalRepl + out.slice(imp.e);
  }
  return out;
}

/**
 * Compute the minimal `./`- or `../`-prefixed path from `fromUrl`'s
 * containing directory to `toUrl`. Both arguments must be absolute,
 * `/`-rooted, `/`-separated paths.
 *
 * @example
 *   relativePath("/client/main.js", "/external/react@18.3.1/index.js")
 *     // → "../external/react@18.3.1/index.js"
 *
 *   relativePath("/external/react@18.3.1/index.js",
 *                "/external/react@18.3.1/jsx-runtime.js")
 *     // → "./jsx-runtime.js"
 *
 *   relativePath("/external/react@18.3.1/cjs/react.development.js",
 *                "/external/scheduler@0.23.2/index.js")
 *     // → "../../scheduler@0.23.2/index.js"
 */
export function relativePath(fromUrl: string, toUrl: string): string {
  // Strip leading '/'; drop the importing file's basename so we work
  // from its containing directory.
  const fromSegments = fromUrl.split("/").slice(1, -1);
  const toSegments = toUrl.split("/").slice(1);
  let common = 0;
  while (
    common < fromSegments.length &&
    common < toSegments.length - 1 &&
    fromSegments[common] === toSegments[common]
  ) {
    common++;
  }
  const up = fromSegments.length - common;
  const rest = toSegments.slice(common).join("/");
  if (up === 0) return `./${rest}`;
  return `${"../".repeat(up)}${rest}`;
}
