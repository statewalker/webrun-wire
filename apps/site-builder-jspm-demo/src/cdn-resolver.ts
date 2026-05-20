// CdnResolver — build-time pipeline that turns a tree of first-party
// .ts/.tsx/.js source (with bare specifiers) into rewritten output plus a
// same-origin /external/ MemFilesApi containing every transitive third-
// party dependency, with every internal reference rewritten to a relative
// path. Runs once on demand via `resolveAndPrefetch()` — no live HMR.
//
// The CDN is pluggable via `setCdnProvider`. Two providers ship in v1:
// JspmProvider (full transitive map computed up front via @jspm/generator)
// and EsmShProvider (lazy: walk + lex). See ./cdn-provider.ts.

import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { CdnProvider } from "./cdn-provider.js";
import { JspmProvider } from "./jspm-provider.js";
import { discoverSpecifiers, init, relativePath, rewriteImports } from "./lex-rewrite.js";
import { isScriptPath, transformSource } from "./script-transform.js";

interface SourcePackageJson {
  dependencies?: Record<string, string>;
}

export interface ResolveOutput {
  /** Per-mount rewritten output. Keyed by the mount path passed to `addSource`. */
  outputs: Map<string, FilesApi>;
  /** Same-origin `/external/<pkg>@<v>/<file>` cache populated by recursive prefetch. */
  external: FilesApi;
  /** Sidecar `{ imports: { <bare-spec>: <relative-./external/-path> } }`. Not load-bearing. */
  manifest: { imports: Record<string, string> };
}

/** Optional logger called for each diagnostic event during resolution. */
export type ResolverLogger = (event: ResolverEvent) => void;

export type ResolverEvent =
  | { kind: "discover"; specifierCount: number; mountCount: number; provider: string }
  | { kind: "install"; targets: string[] }
  | { kind: "fetch-start"; url: string; pkg: string; version: string }
  | {
      kind: "fetch-done";
      url: string;
      pkg: string;
      version: string;
      bytes: number;
      rewritten: boolean;
    }
  | {
      kind: "rewrite-source";
      mount: string;
      path: string;
      bareSpecCount: number;
    }
  | { kind: "manifest"; entryCount: number };

const MANIFEST_PATH = "/resolution-manifest.json";

function externalAbsPath(pkg: string, version: string, file: string): string {
  return `/external/${pkg}@${version}${file.startsWith("/") ? file : `/${file}`}`;
}

function isBareSpecifier(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.startsWith("http://") || spec.startsWith("https://")) return false;
  return true;
}

function packageNameOf(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return spec.split("/")[0];
}

export class CdnResolver {
  #siteKey: string = "";
  #packageJson: SourcePackageJson | null = null;
  #sources = new Map<string, FilesApi>();
  #logger: ResolverLogger | null = null;
  #provider: CdnProvider = new JspmProvider();

  setSiteKey(key: string): this {
    this.#siteKey = key;
    return this;
  }

  setPackageJson(json: SourcePackageJson): this {
    this.#packageJson = json;
    return this;
  }

  setCdnProvider(provider: CdnProvider): this {
    this.#provider = provider;
    return this;
  }

  addSource(mountPath: string, api: FilesApi): this {
    const normalized = mountPath.startsWith("/") ? mountPath : `/${mountPath}`;
    this.#sources.set(normalized.replace(/\/$/, ""), api);
    return this;
  }

  setLogger(logger: ResolverLogger): this {
    this.#logger = logger;
    return this;
  }

  #emit(event: ResolverEvent): void {
    this.#logger?.(event);
  }

  async resolveAndPrefetch(): Promise<ResolveOutput> {
    if (!this.#packageJson) throw new Error("CdnResolver: setPackageJson() not called");
    if (this.#sources.size === 0) {
      throw new Error("CdnResolver: at least one addSource() required");
    }
    await init;
    const provider = this.#provider;
    const deps = this.#packageJson.dependencies ?? {};

    // (1) Walk every source FilesApi; transpile .ts/.tsx via sucrase.
    const transpiled = new Map<string, Map<string, string>>();
    for (const [mount, fs] of this.#sources) {
      const inner = new Map<string, string>();
      for await (const entry of fs.list("/", { recursive: true })) {
        if (entry.kind !== "file") continue;
        const source = await readText(fs, entry.path);
        if (isScriptPath(entry.path)) {
          const outPath = entry.path.replace(/\.tsx?$/, ".js");
          inner.set(outPath, transformSource(entry.path, source));
        } else {
          inner.set(entry.path, source);
        }
      }
      transpiled.set(mount, inner);
    }

    // (2) Discover bare specifiers + validate.
    const bareSpecs = new Set<string>();
    const bareSpecSources = new Map<string, string>();
    for (const [mount, inner] of transpiled) {
      for (const [path, code] of inner) {
        if (!isScriptPath(path)) continue;
        for (const spec of discoverSpecifiers(code)) {
          if (!isBareSpecifier(spec)) continue;
          if (!bareSpecs.has(spec)) {
            bareSpecs.add(spec);
            bareSpecSources.set(spec, `${mount}${path}`);
          }
        }
      }
    }
    for (const spec of bareSpecs) {
      const pkg = packageNameOf(spec);
      if (!(pkg in deps)) {
        throw new Error(
          `Bare specifier "${spec}" used in ${bareSpecSources.get(spec)} but its package "${pkg}" is not listed in package.json's dependencies`,
        );
      }
    }
    this.#emit({
      kind: "discover",
      specifierCount: bareSpecs.size,
      mountCount: this.#sources.size,
      provider: provider.name,
    });

    // (3) Ask the provider to resolve every top-level bare specifier.
    this.#emit({ kind: "install", targets: [...bareSpecs] });
    const specToUrl = await provider.resolveTopLevel(deps, bareSpecs);

    // (4) Recursive prefetch loop seeded with every URL the provider
    //     returned. On each fetch, lex-rewrite internal refs to relative
    //     /external/ paths, write the result, enqueue newly-seen URLs.
    const external = new MemFilesApi();
    const fetched = new Set<string>();
    const queue: string[] = [];
    for (const url of specToUrl.values()) queue.push(url);

    while (queue.length > 0) {
      const url = queue.shift() as string;
      if (fetched.has(url)) continue;
      fetched.add(url);
      const parsed = provider.parseUrl(url);
      if (!parsed) continue;
      const absHere = externalAbsPath(parsed.pkg, parsed.version, parsed.file);
      this.#emit({ kind: "fetch-start", url, pkg: parsed.pkg, version: parsed.version });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
      const code = await res.text();
      const rewritten = rewriteImports(code, (spec) =>
        mapCdnSpecifier({
          spec,
          fromAbs: absHere,
          parentUrl: url,
          provider,
          queue,
          fetched,
        }),
      );
      const relInExternal = absHere.replace(/^\/external/, "");
      await writeText(external, relInExternal, rewritten);
      this.#emit({
        kind: "fetch-done",
        url,
        pkg: parsed.pkg,
        version: parsed.version,
        bytes: rewritten.length,
        rewritten: rewritten !== code,
      });
    }

    // (5) Rewrite first-party files using the spec→URL map.
    const outputs = new Map<string, FilesApi>();
    for (const [mount, inner] of transpiled) {
      const out = new MemFilesApi();
      for (const [path, code] of inner) {
        if (!isScriptPath(path) && !path.endsWith(".js")) {
          await writeText(out, path, code);
          continue;
        }
        const fileAbs = `${mount}${path}`;
        const bareCount = discoverSpecifiers(code).filter(isBareSpecifier).length;
        const rewritten = rewriteImports(code, (spec) => {
          if (!isBareSpecifier(spec)) return spec;
          const url = specToUrl.get(spec);
          if (!url) {
            throw new Error(`Resolver did not produce a URL for "${spec}" (used in ${fileAbs})`);
          }
          const p = provider.parseUrl(url);
          if (!p) {
            throw new Error(`Provider "${provider.name}" cannot parse own URL: ${url}`);
          }
          return relativePath(fileAbs, externalAbsPath(p.pkg, p.version, p.file));
        });
        await writeText(out, path, rewritten);
        this.#emit({ kind: "rewrite-source", mount, path, bareSpecCount: bareCount });
      }
      outputs.set(mount, out);
    }

    // (6) Resolution manifest sidecar.
    const manifest = { imports: {} as Record<string, string> };
    const sampleMount = this.#sources.keys().next().value as string;
    const manifestAbs = `${sampleMount}${MANIFEST_PATH}`;
    for (const spec of [...bareSpecs].sort()) {
      const url = specToUrl.get(spec);
      if (!url) continue;
      const p = provider.parseUrl(url);
      if (!p) continue;
      manifest.imports[spec] = relativePath(manifestAbs, externalAbsPath(p.pkg, p.version, p.file));
    }
    const manifestJson = JSON.stringify(manifest, null, 2);
    for (const out of outputs.values()) {
      await writeText(out, MANIFEST_PATH, manifestJson);
    }
    this.#emit({ kind: "manifest", entryCount: Object.keys(manifest.imports).length });

    void this.#siteKey;
    return { outputs, external, manifest };
  }
}

interface CdnSpecifierContext {
  spec: string;
  fromAbs: string;
  parentUrl: string;
  provider: CdnProvider;
  queue: string[];
  fetched: Set<string>;
}

function mapCdnSpecifier(ctx: CdnSpecifierContext): string {
  const { spec, fromAbs, parentUrl, provider, queue, fetched } = ctx;

  // Relative — keep the output text, but enqueue the corresponding CDN
  // sibling so it lands in /external/ alongside its parent.
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const siblingUrl = new URL(spec, parentUrl).toString();
    if (provider.ownsUrl(siblingUrl) && !fetched.has(siblingUrl)) {
      queue.push(siblingUrl);
    }
    return spec;
  }

  // Origin-absolute path — resolve against the parent's origin. esm.sh
  // emits these inside its bundle output (e.g. `/v135/react@.../...`).
  if (spec.startsWith("/")) {
    const absolved = new URL(spec, parentUrl).toString();
    if (provider.ownsUrl(absolved)) {
      const p = provider.parseUrl(absolved);
      if (p) {
        if (!fetched.has(absolved)) queue.push(absolved);
        return relativePath(fromAbs, externalAbsPath(p.pkg, p.version, p.file));
      }
    }
    return spec;
  }

  // Absolute URL on this CDN — canonical, just relativize.
  if (provider.ownsUrl(spec)) {
    const p = provider.parseUrl(spec);
    if (!p) return spec;
    if (!fetched.has(spec)) queue.push(spec);
    return relativePath(fromAbs, externalAbsPath(p.pkg, p.version, p.file));
  }

  // Bare specifier inside CDN content — let the provider try to resolve.
  if (isBareSpecifier(spec)) {
    const resolvedUrl = provider.resolveSpecifier(spec, parentUrl);
    if (resolvedUrl) {
      const p = provider.parseUrl(resolvedUrl);
      if (p) {
        if (!fetched.has(resolvedUrl)) queue.push(resolvedUrl);
        return relativePath(fromAbs, externalAbsPath(p.pkg, p.version, p.file));
      }
    }
    // Provider doesn't know this specifier — leave as bare. Likely a
    // dynamic import of a path the user has not pinned.
    return spec;
  }

  return spec;
}
