import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";
import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { HostedSiteBuilder, newServerRunner } from "@statewalker/webrun-site-host";
import { createWorkspace, storageKindFromHash } from "./create-workspace.js";
import { deriveLock } from "./derive-lock.js";
import { ensureWorkspace } from "./seed.js";

// The runner is app-agnostic: it seeds a workspace `FilesApi` with the bundled
// payload, transpiles + resolves it with `newModuleServer` (TS/TSX + npm deps →
// same-origin URLs, no CDN, no import map), and hosts the result behind a
// same-origin ServiceWorker. It knows nothing about "notes" — only the fixed
// workspace convention (`/package.json`, `/server/index.ts`, `/client/...`).

const logEl = document.querySelector<HTMLDivElement>("#log");
const iframeEl = document.querySelector<HTMLIFrameElement>("#preview");
if (!logEl || !iframeEl) throw new Error("runner layout missing");

function log(message: string, isError = false): void {
  const p = document.createElement("p");
  if (isError) p.className = "err";
  p.textContent = message;
  logEl?.appendChild(p);
}

try {
  logEl.innerHTML = "";
  const swUrl = new URL("./sw-worker.js", document.baseURI).href;

  const kind = storageKindFromHash(location.hash);
  const workspace = await createWorkspace(kind);
  log(`storage backend: ${kind}`);

  const seeded = await ensureWorkspace(workspace);
  log(seeded ? "workspace seeded" : "workspace source up to date");

  const lock = await deriveLock(workspace);
  log(`lock derived: ${JSON.stringify(lock)}`);

  // Isolate external npm deps under `/deps/` while authored project files stay at
  // `/~/` — the app lives at `<site>/~/client|server/…`, its dependencies at
  // `<site>/deps/<pkg>@<ver>/…`, both served by the one module server.
  const server = newModuleServer({
    cache: new MemFilesApi(),
    project: workspace,
    target: "browser",
    lock,
    depsPath: "/deps/",
  });
  log("module server ready");

  // `/api/*` (specific) must be registered before `/*` (catch-all → module
  // server, which serves both `/~/…` project files and `/deps/…` packages).
  // SiteBuilder matches by URLPattern over the whole pathname, so the patterns
  // carry a `*`. The server runner dynamic-imports the transpiled server entry at
  // its module-server URL and passes the workspace as `env.data`.
  let baseUrl = "";
  const handler = new SiteBuilder()
    .setEndpoint(
      "/api/*",
      newServerRunner("/~/server/index.ts", () => baseUrl, { data: workspace }),
    )
    .setEndpoint("/*", server.fetch)
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();

  const site = await new HostedSiteBuilder()
    .setSiteKey("notes-demo")
    .setServiceWorkerUrl(swUrl)
    .setHandler(handler)
    .build();
  baseUrl = site.baseUrl;
  log(`site mounted at ${site.baseUrl}`);

  iframeEl.src = `${site.baseUrl}~/client/index.html`;
  log(`iframe → ${iframeEl.src}`);
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`, true);
  console.error(error);
}
