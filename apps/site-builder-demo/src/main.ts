import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { clientResources, serverResources } from "./site.js";

const logEl = document.querySelector<HTMLDivElement>("#log");
const previewEl = document.querySelector<HTMLIFrameElement>("#preview");
if (!logEl || !previewEl) throw new Error("demo layout missing");

function log(message: string, isError = false): void {
  const p = document.createElement("p");
  if (isError) p.className = "err";
  p.textContent = message;
  logEl?.appendChild(p);
}

try {
  logEl.innerHTML = "";

  // `HostedSiteBuilder` wraps `SiteBuilder` + `SwHttpAdapter`:
  // - records pass straight in; they're auto-wrapped in `MemFilesApi`
  // - `setServerRunner` generates the dynamic-import /api endpoint;
  //   the third arg is the env bag passed to the imported module on
  //   every call (alongside the URL params)
  // - `.build()` registers the SW, awaits activation, and returns a
  //   ready-to-use `HostedSite { baseUrl, stop }` handle.
  const site = await new HostedSiteBuilder()
    .setSiteKey("demo")
    .setFiles("/client", clientResources)
    .setFiles("/server", serverResources)
    .setServerRunner("/api", "/server/api/index.js", {
      greeting: "Hello",
      service: "site-builder-demo",
    })
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();
  log(`Site mounted at ${site.baseUrl}`);

  // Full path, not a directory URL — SiteBuilder only serves exact-match
  // files unless `directoryIndex` is explicitly configured.
  previewEl.src = `${site.baseUrl}client/index.html`;
  log(`iframe → ${previewEl.src}`);
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`, true);
  console.error(error);
}
