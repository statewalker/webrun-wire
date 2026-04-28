import { transform as sucraseTransform } from "sucrase";

const cache = new Map<string, string>();

async function sha256(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const SCRIPT_RE = /\.(?:[mc]?[tj]sx?)$/i;
const JSX_RE = /\.(?:[mc]?[tj]sx)$/i;

/**
 * Build a `ServeFilesOptions.transform` filter that transpiles TS/TSX/JSX
 * source on the fly via sucrase. For non-script paths or non-200 responses,
 * passes through unchanged. Caches transpiled output by source SHA-256 so
 * repeated fetches do not re-transpile.
 */
export function newScriptTransform(): (request: Request, response: Response) => Promise<Response> {
  return async (request, response) => {
    const url = new URL(request.url);
    // Diagnostic: prints once per script fetch so a stale-SW scenario
    // (filter never invoked) is obvious in DevTools. Remove once the
    // spike graduates past Step 1.
    console.log("[script-transform]", url.pathname, "status=", response.status);
    if (response.status !== 200) return response;
    if (!SCRIPT_RE.test(url.pathname)) return response;

    const source = await response.text();
    const key = await sha256(source);
    let code = cache.get(key);
    if (code === undefined) {
      const isJsx = JSX_RE.test(url.pathname);
      const transforms: Array<"typescript" | "jsx"> = isJsx
        ? ["typescript", "jsx"]
        : ["typescript"];
      // Classic JSX so the spike has no runtime dependency: `<p>x</p>` →
      // `h('p', null, 'x')`. Pair with a hand-rolled `h` factory in user code.
      const result = sucraseTransform(source, {
        transforms,
        production: true,
        jsxRuntime: isJsx ? "classic" : undefined,
        jsxPragma: isJsx ? "h" : undefined,
        jsxFragmentPragma: isJsx ? "Fragment" : undefined,
      });
      code = result.code;
      cache.set(key, code);
    }

    return new Response(code, {
      status: 200,
      headers: { "Content-Type": "text/javascript" },
    });
  };
}
