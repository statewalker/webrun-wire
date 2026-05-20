import type { CdnProvider, ParsedCdnUrl } from "./cdn-provider.js";

// jsDelivr serves npm content under two roughly-equivalent shapes that
// matter to us:
//   1. https://cdn.jsdelivr.net/npm/<pkg>@<v>[/<subpath>]/+esm
//      The `/+esm` endpoint returns a small ESM entry whose internal
//      references are absolute jsdelivr URLs (typically to other
//      /+esm entries or to `_/<hash>.mjs` chunks under the same package).
//   2. https://cdn.jsdelivr.net/npm/<pkg>@<v>/_/<file>.mjs
//      Pre-bundled chunk files. Stable cache keys.
// Both fit the resolver's <pkg>@<v>/<file> cache scheme — we keep `/+esm`
// and `/_` literally inside the <file> segment so the absolute URL is
// reversible.
const JSDELIVR_URL_RE =
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[^/]+\/[^@/]+|[^@/]+)@([^/]+)(\/.*)?$/;

function packageNameOf(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return spec.split("/")[0];
}

function isConcreteVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v);
}

/**
 * Provider backed by jsDelivr's `/+esm` mode. Resolution is two steps:
 * (1) one call to jsDelivr's data API per unique package to convert
 * ranges/`*` into concrete `X.Y.Z` versions; (2) construct URLs of the
 * form `cdn.jsdelivr.net/npm/<pkg>@<v>[/<subpath>]/+esm` for each
 * specifier. The recursive prefetch loop discovers transitive deps by
 * lexing fetched responses.
 */
export class JsdelivrProvider implements CdnProvider {
  readonly name = "jsdelivr";

  async resolveTopLevel(
    deps: Record<string, string>,
    specifiers: Iterable<string>,
  ): Promise<Map<string, string>> {
    const concreteVersions = new Map<string, string>();
    const specList = [...specifiers];
    const uniquePkgs = new Set<string>();
    for (const spec of specList) uniquePkgs.add(packageNameOf(spec));
    await Promise.all(
      [...uniquePkgs].map(async (pkg) => {
        const range = deps[pkg];
        if (!range) return;
        concreteVersions.set(pkg, await this.#resolveVersion(pkg, range));
      }),
    );

    const out = new Map<string, string>();
    for (const spec of specList) {
      const pkg = packageNameOf(spec);
      const ver = concreteVersions.get(pkg);
      if (!ver) continue;
      const sub = spec.slice(pkg.length);
      // jsDelivr accepts /+esm on both the package root and on extensionless
      // subpaths (resolves via package.json#exports). For paths that look
      // like a literal file (have a dot in the last segment), don't append
      // /+esm — request the file directly.
      const looksLikeFile = /\.[^/]+$/.test(sub);
      const endpoint = looksLikeFile ? sub : `${sub}/+esm`;
      out.set(spec, `https://cdn.jsdelivr.net/npm/${pkg}@${ver}${endpoint}`);
    }
    return out;
  }

  async #resolveVersion(pkg: string, range: string): Promise<string> {
    if (isConcreteVersion(range)) return range;
    // jsDelivr's data API returns a concrete version for any npm range.
    // `*` and `latest` both work as the specifier value.
    const specifier = range === "*" ? "latest" : range;
    const url = `https://data.jsdelivr.com/v1/packages/npm/${encodeURIComponent(pkg)}/resolved?specifier=${encodeURIComponent(specifier)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `jsDelivr data API could not resolve ${pkg}@${range}: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as { version?: string };
    if (!json.version) {
      throw new Error(
        `jsDelivr data API for ${pkg}@${range} did not return a version: ${JSON.stringify(json).slice(0, 200)}`,
      );
    }
    return json.version;
  }

  resolveSpecifier(_specifier: string, _parentUrl: string): string | null {
    // jsDelivr's /+esm output emits absolute jsdelivr URLs for transitive
    // deps, so bare specifiers shouldn't surface during CDN content
    // rewriting. If they do, we don't have version info — fail soft.
    return null;
  }

  ownsUrl(url: string): boolean {
    return url.startsWith("https://cdn.jsdelivr.net/npm/");
  }

  parseUrl(url: string): ParsedCdnUrl | null {
    const m = JSDELIVR_URL_RE.exec(url);
    if (!m) return null;
    const [, pkg, version, rest] = m;
    return { pkg, version, file: rest ?? "/index.js" };
  }
}
