import type { CdnProvider, ParsedCdnUrl } from "./cdn-provider.js";

// Two URL shapes esm.sh emits / accepts:
//   1. https://esm.sh/<pkg>@<v>[/<subpath>]                           — entry
//   2. https://esm.sh/<channel>/<pkg>@<v>/<flavour>/<file>            — bundle
//      where <channel> is "stable", "v135", "gh", etc., and <flavour>
//      is the build target (e.g. "es2022", "deno", "denonext").
// We normalise both shapes to the same `<pkg>@<v>/<file>` key. The
// channel + flavour segments get folded into <file> so the same physical
// bundle file ends up at a unique /external/ path.
const ESM_SH_ENTRY_RE = /^https:\/\/esm\.sh\/(@[^/]+\/[^@/]+|[^@/v][^@/]*)@([^/]+)(\/.*)?$/;
const ESM_SH_BUNDLE_RE = /^https:\/\/esm\.sh\/([^/]+)\/(@[^/]+\/[^@/]+|[^@/]+)@([^/]+)(\/.*)?$/;

function packageNameOf(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return spec.split("/")[0];
}

function isConcreteVersion(v: string): boolean {
  // SemVer X.Y.Z with optional pre-release / build suffix.
  return /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v);
}

/**
 * Provider backed by esm.sh. Resolution is URL-construction (no separate
 * install step); the recursive prefetch loop discovers transitive deps
 * by lexing fetched responses, which contain absolute esm.sh URLs.
 *
 * esm.sh handles its own CJS→ESM wrapping, dead-code elimination, and
 * subpath resolution server-side; we mirror its output verbatim into
 * `/external/` with only specifier rewriting on top.
 */
export class EsmShProvider implements CdnProvider {
  readonly name = "esm.sh";

  async resolveTopLevel(
    deps: Record<string, string>,
    specifiers: Iterable<string>,
  ): Promise<Map<string, string>> {
    // Pre-resolve every unique package to a concrete `X.Y.Z` version, so
    // the /external/ path key is stable. esm.sh accepts ranges in URLs
    // (`@*`, `@^4`, `@~3.23`) but they're not safe as cache keys.
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
      out.set(spec, `https://esm.sh/${pkg}@${ver}${sub}`);
    }
    return out;
  }

  async #resolveVersion(pkg: string, range: string): Promise<string> {
    if (isConcreteVersion(range)) return range;
    // GET https://esm.sh/<pkg>[@<range>] returns a tiny JS entry whose body
    // references the resolved version path. We pluck `<pkg>@<X.Y.Z>` out
    // of that body. esm.sh accepts both `*` (encoded as no version
    // segment) and any npm range.
    const url = range === "*"
      ? `https://esm.sh/${pkg}`
      : `https://esm.sh/${pkg}@${range}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `esm.sh could not resolve ${pkg}@${range}: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const body = await res.text();
    const escapedPkg = pkg.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const re = new RegExp(`${escapedPkg}@(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)`);
    const m = re.exec(body);
    if (!m) {
      throw new Error(
        `esm.sh response for ${pkg}@${range} did not embed a concrete version: ${body.slice(0, 200)}…`,
      );
    }
    return m[1];
  }

  resolveSpecifier(specifier: string, _parentUrl: string): string | null {
    // esm.sh emits absolute URLs for transitive deps inside its own
    // responses, so by the time we encounter a bare specifier in CDN
    // content it's something we don't have version info for. Fail soft;
    // the caller will treat it as unresolved and pass through.
    if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
    return null;
  }

  ownsUrl(url: string): boolean {
    return url.startsWith("https://esm.sh/");
  }

  parseUrl(url: string): ParsedCdnUrl | null {
    // Try the bundle form first (more specific — it has an extra path
    // segment before the package). Fall back to the entry form.
    const bundle = ESM_SH_BUNDLE_RE.exec(url);
    if (bundle) {
      const [, channel, pkg, version, file] = bundle;
      return {
        pkg,
        version,
        file: `/${channel}${file ?? "/index.js"}`,
      };
    }
    const entry = ESM_SH_ENTRY_RE.exec(url);
    if (entry) {
      const [, pkg, version, file] = entry;
      return { pkg, version, file: file ?? "/index.js" };
    }
    return null;
  }
}
