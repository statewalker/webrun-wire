// Sucrase-based transform: TS/TSX -> JS (with automatic JSX runtime).
// The result still contains bare specifiers — those are rewritten later
// by the JspmResolver's lex pass. This file just normalises syntax.

import { transform as sucraseTransform } from "sucrase";

const SCRIPT_RE = /\.(?:[mc]?[tj]sx?)$/i;
const JSX_RE = /\.(?:[mc]?[tj]sx)$/i;

export interface TransformedSource {
  path: string;
  code: string;
}

/**
 * Transpile a single file. JSX files use the automatic JSX runtime
 * (`react/jsx-runtime`), which sucrase emits as an implicit
 * `import { jsx as _jsx } from "react/jsx-runtime"` at the top of the
 * file. The lex pass downstream picks that up as a normal bare specifier.
 */
export function transformSource(path: string, source: string): string {
  const isJsx = JSX_RE.test(path);
  const transforms: Array<"typescript" | "jsx"> = isJsx ? ["typescript", "jsx"] : ["typescript"];
  const result = sucraseTransform(source, {
    transforms,
    production: true,
    jsxRuntime: isJsx ? "automatic" : undefined,
    jsxImportSource: isJsx ? "react" : undefined,
  });
  return result.code;
}

export function isScriptPath(path: string): boolean {
  return SCRIPT_RE.test(path);
}

/**
 * Adapter that returns a `ServeFilesOptions.transform` filter wrapping the
 * same sucrase pass. Kept for parity with the spike; the demo's main
 * pipeline (`JspmResolver`) transforms files up front rather than at
 * fetch time, but the filter is useful for any mount that wants on-the-fly
 * TS transpilation (e.g. served package.json passthrough).
 */
export function newScriptTransform(): (request: Request, response: Response) => Promise<Response> {
  const cache = new Map<string, string>();
  return async (request, response) => {
    const url = new URL(request.url);
    if (response.status !== 200) return response;
    if (!isScriptPath(url.pathname)) return response;
    const source = await response.text();
    const key = await sha256(source);
    let code = cache.get(key);
    if (code === undefined) {
      code = transformSource(url.pathname, source);
      cache.set(key, code);
    }
    return new Response(code, {
      status: 200,
      headers: { "Content-Type": "text/javascript" },
    });
  };
}

async function sha256(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
