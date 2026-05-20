import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { HostedSiteBuilder, newServerRunner } from "@statewalker/webrun-site-host";
import type { CdnProvider } from "./cdn-provider.js";
import { CdnResolver, type ResolverEvent } from "./cdn-resolver.js";
import { CompositeProvider } from "./composite-provider.js";
import { EsmShProvider } from "./esmsh-provider.js";
import { JspmProvider } from "./jspm-provider.js";
import { clientResources, serverResources, sharedPackageJson } from "./site.js";

function makeProvider(name: string): CdnProvider {
  switch (name) {
    case "jspm":
      return new JspmProvider();
    case "esm.sh":
      return new EsmShProvider();
    default:
      throw new Error(`Unknown CDN provider: "${name}" (known: jspm, esm.sh)`);
  }
}

function pickProvider(): CdnProvider {
  const requested = new URLSearchParams(window.location.hash.slice(1)).get("provider");
  if (!requested) return new JspmProvider();
  const names = requested.split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return new JspmProvider();
  if (names.length === 1) return makeProvider(names[0]);
  return new CompositeProvider(names.map(makeProvider));
}

const logEl = document.querySelector<HTMLDivElement>("#log");
const previewEl = document.querySelector<HTMLIFrameElement>("#preview");
const manifestEl = document.querySelector<HTMLPreElement>("#manifest");
if (!logEl || !previewEl || !manifestEl) {
  throw new Error("jspm-demo: page layout missing required elements (#log/#preview/#manifest)");
}

function log(message: string, isError = false): void {
  const p = document.createElement("p");
  if (isError) p.className = "err";
  p.textContent = message;
  logEl?.appendChild(p);
}

async function recordToFilesApi(record: Record<string, string>): Promise<MemFilesApi> {
  const fs = new MemFilesApi();
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(record)) {
    await fs.write(path, [encoder.encode(content)]);
  }
  return fs;
}

function formatResolverEvent(event: ResolverEvent): string {
  switch (event.kind) {
    case "discover":
      return `discovered ${event.specifierCount} bare specifier(s) across ${event.mountCount} mount(s) — provider: ${event.provider}`;
    case "install":
      return `resolving via provider: ${event.targets.join(", ")}`;
    case "fetch-start":
      return `→ ${event.pkg}@${event.version}`;
    case "fetch-done":
      return `  ${event.pkg}@${event.version} — ${event.bytes} bytes${event.rewritten ? " (rewritten)" : ""}`;
    case "rewrite-source":
      return `rewrote ${event.mount}${event.path} (${event.bareSpecCount} bare specifier(s))`;
    case "manifest":
      return `emitted resolution-manifest.json (${event.entryCount} entries)`;
  }
}

try {
  logEl.innerHTML = "";
  log("Building first-party FilesApis…");

  const clientFiles = await recordToFilesApi(clientResources);
  const serverFiles = await recordToFilesApi(serverResources);

  const provider = pickProvider();
  log(
    `CDN provider: ${provider.name} ` +
      "(toggle via #provider=jspm | #provider=esm.sh | #provider=jspm,esm.sh + reload)",
  );
  log("Running CdnResolver (lex + provider resolve + recursive prefetch)…");
  const t0 = performance.now();
  const { outputs, external, manifest } = await new CdnResolver()
    .setSiteKey("jspm")
    .setPackageJson(JSON.parse(sharedPackageJson))
    .setCdnProvider(provider)
    .addSource("/client", clientFiles)
    .addSource("/server", serverFiles)
    .setLogger((event) => log(formatResolverEvent(event)))
    .resolveAndPrefetch();
  const elapsed = (performance.now() - t0).toFixed(1);
  log(`Resolved in ${elapsed}ms — ${Object.keys(manifest.imports).length} first-party specifiers`);

  manifestEl.textContent = JSON.stringify(manifest, null, 2);

  const clientOut = outputs.get("/client");
  const serverOut = outputs.get("/server");
  if (!clientOut || !serverOut) throw new Error("resolver did not produce client/server outputs");

  let baseUrl = "";
  const handler = new SiteBuilder()
    .setFiles("/client", clientOut)
    .setFiles("/server", serverOut)
    .setFiles("/external", external)
    .setEndpoint(
      "/api",
      newServerRunner("/server/api/index.js", () => baseUrl, {
        service: "site-builder-jspm-demo",
      }),
    )
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();

  const swUrl = new URL("./sw-worker.js", document.baseURI).href;
  const site = await new HostedSiteBuilder()
    .setSiteKey("jspm")
    .setServiceWorkerUrl(swUrl)
    .setHandler(handler)
    .build();
  baseUrl = site.baseUrl;
  log(`Site mounted at ${site.baseUrl}`);

  previewEl.src = `${site.baseUrl}client/index.html`;
  log(`iframe → ${previewEl.src}`);
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`, true);
  console.error(error);
}
