// CompositeProvider — chain CDN providers in priority order. Each spec is
// resolved by the first provider that can; later providers only see the
// specs the earlier ones could not bind.
//
// Cross-provider safety: once a spec is bound to a provider, every
// transitive reference for that subtree stays on the same CDN, because
// the fetched bytes contain only that provider's own URLs. So having one
// dep tree on JSPM and another on esm.sh works — the two worlds don't
// collide unless a third-party CDN URL appears in someone else's bytes,
// which doesn't happen in practice.
//
// `ownsUrl` / `parseUrl` / `resolveSpecifier` delegate to whichever
// sub-provider claims the URL; the first matching one wins.

import type { CdnProvider, ParsedCdnUrl } from "./cdn-provider.js";

export class CompositeProvider implements CdnProvider {
  readonly name: string;
  readonly #providers: readonly CdnProvider[];

  constructor(providers: readonly CdnProvider[]) {
    if (providers.length === 0) {
      throw new Error("CompositeProvider requires at least one sub-provider");
    }
    this.#providers = providers;
    this.name = providers.map((p) => p.name).join("+");
  }

  async resolveTopLevel(
    deps: Record<string, string>,
    specifiers: Iterable<string>,
  ): Promise<Map<string, string>> {
    const all = [...specifiers];
    const out = new Map<string, string>();
    let remaining = new Set(all);
    for (const provider of this.#providers) {
      if (remaining.size === 0) break;
      let partial: Map<string, string>;
      try {
        partial = await provider.resolveTopLevel(deps, remaining);
      } catch (err) {
        console.warn(
          `[CompositeProvider] sub-provider "${provider.name}" threw during resolveTopLevel: ${
            err instanceof Error ? err.message : String(err)
          }. Falling through.`,
        );
        continue;
      }
      const stillRemaining = new Set<string>();
      for (const spec of remaining) {
        const url = partial.get(spec);
        if (url) {
          out.set(spec, url);
        } else {
          stillRemaining.add(spec);
        }
      }
      remaining = stillRemaining;
    }
    return out;
  }

  resolveSpecifier(specifier: string, parentUrl: string): string | null {
    for (const provider of this.#providers) {
      // Prefer the provider that owns the parent URL — that keeps a
      // subtree anchored to its CDN. Other providers come after as a
      // last resort.
      if (provider.ownsUrl(parentUrl)) {
        const r = provider.resolveSpecifier(specifier, parentUrl);
        if (r) return r;
      }
    }
    for (const provider of this.#providers) {
      const r = provider.resolveSpecifier(specifier, parentUrl);
      if (r) return r;
    }
    return null;
  }

  ownsUrl(url: string): boolean {
    return this.#providers.some((p) => p.ownsUrl(url));
  }

  parseUrl(url: string): ParsedCdnUrl | null {
    for (const provider of this.#providers) {
      if (provider.ownsUrl(url)) return provider.parseUrl(url);
    }
    return null;
  }
}
