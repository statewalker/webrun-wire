import { Generator } from "@jspm/generator";
import type { CdnProvider, ParsedCdnUrl } from "./cdn-provider.js";

const JSPM_URL_RE = /^https:\/\/ga\.jspm\.io\/npm:(@[^/]+\/[^@]+|[^@]+)@([^/]+)(\/.*)?$/;

function packageNameOf(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return spec.split("/")[0];
}

/**
 * Provider backed by `@jspm/generator` against `ga.jspm.io`. Computes the
 * full transitive import map up front so the recursive prefetch loop has
 * no surprises; emits clean ESM with internal references as absolute
 * `https://ga.jspm.io/npm:...` URLs.
 */
export class JspmProvider implements CdnProvider {
  readonly name = "jspm";
  readonly #generator: Generator;

  constructor() {
    this.#generator = new Generator({
      defaultProvider: "jspm.io",
      env: ["browser", "production", "module"],
    });
  }

  async resolveTopLevel(
    deps: Record<string, string>,
    specifiers: Iterable<string>,
  ): Promise<Map<string, string>> {
    const installs = new Map<string, { target: string; subpath?: `./${string}` | "." }>();
    for (const spec of specifiers) {
      const pkg = packageNameOf(spec);
      const ver = deps[pkg];
      if (!ver) continue;
      const target = `${pkg}@${ver}`;
      const sub = spec.slice(pkg.length);
      const key = `${target}|${sub}`;
      if (installs.has(key)) continue;
      installs.set(key, sub === "" ? { target } : { target, subpath: `.${sub}` as `./${string}` });
    }
    // Per-spec resilience: if JSPM can't install one (e.g. zod@4 isn't
    // indexed in JSPM's CDN as of writing), we want to skip it rather
    // than fail the whole batch. The composite provider relies on this
    // to fall through to the next CDN.
    for (const inst of installs.values()) {
      try {
        await this.#generator.install(inst);
      } catch (err) {
        const subpath = inst.subpath ? inst.subpath.slice(1) : "";
        console.warn(
          `[JspmProvider] install failed for ${inst.target}${subpath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const out = new Map<string, string>();
    for (const spec of specifiers) {
      try {
        const url = this.#generator.resolve(spec, "https://demo.local/");
        if (url) out.set(spec, url);
      } catch {
        // resolve() throws if the spec was never installed — silently
        // skip; the caller's composite chain (or the resolver's
        // discovery check) decides what to do with the gap.
      }
    }
    return out;
  }

  resolveSpecifier(specifier: string, parentUrl: string): string | null {
    try {
      return this.#generator.resolve(specifier, parentUrl) ?? null;
    } catch {
      return null;
    }
  }

  ownsUrl(url: string): boolean {
    return url.startsWith("https://ga.jspm.io/");
  }

  parseUrl(url: string): ParsedCdnUrl | null {
    const m = JSPM_URL_RE.exec(url);
    if (!m) return null;
    return { pkg: m[1], version: m[2], file: m[3] ?? "/index.js" };
  }
}
