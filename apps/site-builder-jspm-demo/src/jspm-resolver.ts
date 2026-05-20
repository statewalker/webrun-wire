// JspmResolver — the build-time pipeline that turns a tree of first-party
// .ts/.tsx/.js source (with bare specifiers) into rewritten output plus a
// same-origin /external/ MemFilesApi containing every transitive third-
// party dependency, with every internal reference rewritten to a relative
// path. Runs once on demand via `resolveAndPrefetch()` — no live HMR.

import { Generator } from "@jspm/generator";
import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
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

/**
 * Optional logger called for each diagnostic event during resolution. Passed
 * via `setLogger`. Useful for surfacing prefetch progress in a host page UI.
 */
export type ResolverLogger = (event: ResolverEvent) => void;

export type ResolverEvent =
  | { kind: "discover"; specifierCount: number; mountCount: number }
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

const JSPM_URL_RE = /^https:\/\/ga\.jspm\.io\/npm:(@[^/]+\/[^@]+|[^@]+)@([^/]+)(\/.*)?$/;
const FIRST_PARTY_BASE = "https://demo.local";
const MANIFEST_PATH = "/resolution-manifest.json";

function parseJspmUrl(url: string): { pkg: string; version: string; file: string } | null {
  const m = JSPM_URL_RE.exec(url);
  if (!m) return null;
  return { pkg: m[1], version: m[2], file: m[3] ?? "/index.js" };
}

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

export class JspmResolver {
  #siteKey: string = "";
  #packageJson: SourcePackageJson | null = null;
  #sources = new Map<string, FilesApi>();
  #logger: ResolverLogger | null = null;

  setSiteKey(key: string): this {
    this.#siteKey = key;
    return this;
  }

  setPackageJson(json: SourcePackageJson): this {
    this.#packageJson = json;
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
    if (!this.#packageJson) throw new Error("JspmResolver: setPackageJson() not called");
    if (this.#sources.size === 0) {
      throw new Error("JspmResolver: at least one addSource() required");
    }
    await init;

    const deps = this.#packageJson.dependencies ?? {};

    // (1) Walk every source FilesApi; transpile .ts/.tsx via sucrase; record
    //     the resulting bytes keyed by mount + output path. Non-script files
    //     are recorded unchanged.
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

    // (2) Discover the union of bare specifiers across all transpiled
    //     scripts. Validate each against package.json dependencies.
    const bareSpecs = new Set<string>();
    const bareSpecSources = new Map<string, string>(); // spec -> first file that introduced it
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
        const src = bareSpecSources.get(spec);
        throw new Error(
          `Bare specifier "${spec}" used in ${src} but its package "${pkg}" is not listed in package.json's dependencies`,
        );
      }
    }
    this.#emit({
      kind: "discover",
      specifierCount: bareSpecs.size,
      mountCount: this.#sources.size,
    });

    // (3) Install each used (pkg, subpath) combination into a JSPM generator.
    const generator = new Generator({
      defaultProvider: "jspm.io",
      env: ["browser", "production", "module"],
    });
    const installs = new Map<string, { target: string; subpath?: `./${string}` | "." }>();
    for (const spec of bareSpecs) {
      const pkg = packageNameOf(spec);
      const ver = deps[pkg];
      const target = `${pkg}@${ver}`;
      const sub = spec.slice(pkg.length);
      const key = `${target}|${sub}`;
      if (installs.has(key)) continue;
      installs.set(key, sub === "" ? { target } : { target, subpath: `.${sub}` as `./${string}` });
    }
    this.#emit({
      kind: "install",
      targets: [...installs.values()].map((i) =>
        i.subpath ? `${i.target}${i.subpath.slice(1)}` : i.target,
      ),
    });
    for (const inst of installs.values()) {
      // eslint-disable-next-line no-await-in-loop
      await generator.install(inst);
    }

    // (4) Recursive prefetch loop. Seed with every JSPM URL the generator
    //     produced; on each fetch, lex-rewrite internal refs, write to
    //     `external`, enqueue any newly-seen URLs.
    const importMap = generator.getMap();
    const queue: string[] = [];
    collectJspmUrls(importMap, queue);

    const external = new MemFilesApi();
    const fetched = new Set<string>();

    while (queue.length > 0) {
      const url = queue.shift() as string;
      if (fetched.has(url)) continue;
      fetched.add(url);
      const parsed = parseJspmUrl(url);
      if (!parsed) continue;
      const absHere = externalAbsPath(parsed.pkg, parsed.version, parsed.file);
      this.#emit({
        kind: "fetch-start",
        url,
        pkg: parsed.pkg,
        version: parsed.version,
      });
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
      }
      // eslint-disable-next-line no-await-in-loop
      const code = await res.text();
      const rewrittenCode = rewriteImports(code, (spec) =>
        mapCdnSpecifier({
          spec,
          fromAbs: absHere,
          parentUrl: url,
          generator,
          queue,
          fetched,
        }),
      );
      const relInExternal = absHere.replace(/^\/external/, "");
      // eslint-disable-next-line no-await-in-loop
      await writeText(external, relInExternal, rewrittenCode);
      this.#emit({
        kind: "fetch-done",
        url,
        pkg: parsed.pkg,
        version: parsed.version,
        bytes: rewrittenCode.length,
        rewritten: rewrittenCode !== code,
      });
    }

    // (5) Rewrite every first-party script. Non-script files are emitted
    //     untouched.
    const outputs = new Map<string, FilesApi>();
    for (const [mount, inner] of transpiled) {
      const out = new MemFilesApi();
      for (const [path, code] of inner) {
        if (!isScriptPath(path) && !path.endsWith(".js")) {
          // Non-script files (html, css, json, …) pass through verbatim.
          // eslint-disable-next-line no-await-in-loop
          await writeText(out, path, code);
          continue;
        }
        const fileAbs = `${mount}${path}`;
        const parentUrl = `${FIRST_PARTY_BASE}${fileAbs}`;
        const bareCount = discoverSpecifiers(code).filter(isBareSpecifier).length;
        const rewritten = rewriteImports(code, (spec) =>
          mapFirstPartySpecifier({
            spec,
            fromAbs: fileAbs,
            parentUrl,
            generator,
          }),
        );
        // eslint-disable-next-line no-await-in-loop
        await writeText(out, path, rewritten);
        this.#emit({
          kind: "rewrite-source",
          mount,
          path,
          bareSpecCount: bareCount,
        });
      }
      outputs.set(mount, out);
    }

    // (6) Build the resolution manifest. One entry per first-party bare
    //     specifier, value relative to the manifest's own location.
    //     The manifest is written into every first-party mount at
    //     `/resolution-manifest.json` so it's inspectable from the iframe.
    const manifest = { imports: {} as Record<string, string> };
    for (const spec of [...bareSpecs].sort()) {
      const resolvedUrl = generator.resolve(spec, `${FIRST_PARTY_BASE}/`);
      const p = parseJspmUrl(resolvedUrl);
      if (!p) continue;
      // Values are relative to each mount's MANIFEST_PATH location.
      // All mounts are at depth 1 (e.g. /client/), so the relative path is
      // identical for every mount and we compute it once against a
      // canonical mount.
      const sampleMount = this.#sources.keys().next().value as string;
      const manifestAbs = `${sampleMount}${MANIFEST_PATH}`;
      manifest.imports[spec] = relativePath(manifestAbs, externalAbsPath(p.pkg, p.version, p.file));
    }
    const manifestJson = JSON.stringify(manifest, null, 2);
    for (const out of outputs.values()) {
      // eslint-disable-next-line no-await-in-loop
      await writeText(out, MANIFEST_PATH, manifestJson);
    }
    this.#emit({
      kind: "manifest",
      entryCount: Object.keys(manifest.imports).length,
    });

    // siteKey is recorded for future site-bound features (e.g. emitting an
    // absolute manifest sidecar). Not used in v1 because all bundle output
    // is mount-prefix-agnostic by construction.
    void this.#siteKey;

    console.log(
      `[JspmResolver] resolveAndPrefetch complete: ${fetched.size} URLs fetched, ${outputs.size} mounts rewritten`,
    );
    console.log(`[JspmResolver] manifest:`, manifest);
    console.log(`[JspmResolver] fetched URLs:`, [...fetched].sort());
    console.log(`[JspmResolver] files:`, external);

    return { outputs, external, manifest };
  }
}

interface SpecifierContext {
  spec: string;
  fromAbs: string;
  parentUrl: string;
  generator: Generator;
}

interface CdnSpecifierContext extends SpecifierContext {
  queue: string[];
  fetched: Set<string>;
}

function mapFirstPartySpecifier(ctx: SpecifierContext): string {
  const { spec, fromAbs, parentUrl, generator } = ctx;
  if (!isBareSpecifier(spec)) return spec;
  // First-party files never import directly from ga.jspm.io URLs.
  const resolvedUrl = generator.resolve(spec, parentUrl);
  const p = parseJspmUrl(resolvedUrl);
  if (!p) {
    throw new Error(`JSPM resolution for "${spec}" produced a non-JSPM URL: ${resolvedUrl}`);
  }
  return relativePath(fromAbs, externalAbsPath(p.pkg, p.version, p.file));
}

function mapCdnSpecifier(ctx: CdnSpecifierContext): string {
  const { spec, fromAbs, parentUrl, generator, queue, fetched } = ctx;

  // Relative specifier inside a CDN file — keep the output text verbatim,
  // but enqueue the corresponding CDN sibling URL so it lands in
  // /external/ alongside its parent. JSPM packages routinely emit private
  // sub-files like `./_/AbCdEf.js` next to their entry point.
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const siblingUrl = new URL(spec, parentUrl).toString();
    if (siblingUrl.startsWith("https://ga.jspm.io/") && !fetched.has(siblingUrl)) {
      queue.push(siblingUrl);
    }
    return spec;
  }

  // Origin-absolute path — also relative-to-page, leave alone.
  if (spec.startsWith("/")) return spec;

  // Absolute JSPM URL — already canonical, just relativize.
  if (spec.startsWith("https://ga.jspm.io/")) {
    const p = parseJspmUrl(spec);
    if (!p) return spec;
    if (!fetched.has(spec)) queue.push(spec);
    return relativePath(fromAbs, externalAbsPath(p.pkg, p.version, p.file));
  }

  // Bare specifier inside CDN content — resolve via the generator.
  if (isBareSpecifier(spec)) {
    const resolvedUrl = generator.resolve(spec, parentUrl);
    const p = parseJspmUrl(resolvedUrl);
    if (!p) {
      throw new Error(
        `JSPM resolution for "${spec}" (parent ${parentUrl}) produced a non-JSPM URL: ${resolvedUrl}`,
      );
    }
    if (!fetched.has(resolvedUrl)) queue.push(resolvedUrl);
    return relativePath(fromAbs, externalAbsPath(p.pkg, p.version, p.file));
  }

  // Some other absolute URL (e.g. http(s)) — leave alone.
  return spec;
}

function collectJspmUrls(
  map: {
    imports?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
  },
  out: string[],
): void {
  const push = (url: string): void => {
    if (url.startsWith("https://ga.jspm.io/")) out.push(url);
  };
  for (const url of Object.values(map.imports ?? {})) push(url);
  for (const scope of Object.values(map.scopes ?? {})) {
    for (const url of Object.values(scope)) push(url);
  }
}
