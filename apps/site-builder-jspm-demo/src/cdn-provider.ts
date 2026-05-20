// CdnProvider — pluggable backend that turns bare specifiers into starting
// URLs on a particular CDN, and recognises URLs that belong to that CDN
// inside fetched bytes so they can be normalised to /external/ paths.
//
// Two providers ship in v1: `jspmProvider` (uses @jspm/generator to compute
// the full transitive map up front) and `esmShProvider` (constructs
// esm.sh URLs directly; transitives are discovered lazily by lex+follow).
//
// Adding another CDN means: write a new CdnProvider impl. The resolver
// itself does not change.

export interface ParsedCdnUrl {
  pkg: string;
  version: string;
  /** Always starts with "/". e.g. "/index.js", "/jsx-runtime.js", "/cjs/x.js". */
  file: string;
}

export interface CdnProvider {
  /** Stable identifier — surfaced in logs. e.g. "jspm" or "esm.sh". */
  readonly name: string;

  /**
   * Given the source `package.json#dependencies` table and the set of bare
   * specifiers actually used in source code, return a map from each
   * specifier to its canonical starting URL on this CDN.
   *
   * The provider may install packages into its own state during this call
   * (JSPM does), in which case subsequent `resolveSpecifier` lookups should
   * succeed for transitive specifiers too.
   */
  resolveTopLevel(
    deps: Record<string, string>,
    specifiers: Iterable<string>,
  ): Promise<Map<string, string>>;

  /**
   * Resolve a bare specifier encountered later (during recursive CDN
   * content rewriting), using the same state the provider built up during
   * `resolveTopLevel`. Returns the canonical URL string, or null if the
   * provider doesn't know about this specifier.
   *
   * @param specifier the bare specifier (e.g. "scheduler", "react-dom/client")
   * @param parentUrl absolute URL of the file whose import is being resolved,
   *                  used by providers that do scope-aware resolution (JSPM).
   */
  resolveSpecifier(specifier: string, parentUrl: string): string | null;

  /** True if `url` is an absolute URL on this CDN's origin. */
  ownsUrl(url: string): boolean;

  /**
   * Parse a URL on this CDN into the canonical `<pkg>, <version>, <file>`
   * triple. Returns null for URLs the provider doesn't recognise even
   * after `ownsUrl` returns true (e.g. malformed inputs).
   */
  parseUrl(url: string): ParsedCdnUrl | null;
}
