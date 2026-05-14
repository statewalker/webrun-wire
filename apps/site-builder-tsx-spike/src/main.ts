import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { HostedSiteBuilder, newServerRunner } from "@statewalker/webrun-site-host";
import { newScriptTransform } from "./script-transform.js";
import { clientResources, serverResources } from "./site.js";

const logEl = document.querySelector<HTMLDivElement>("#log");
const previewEl = document.querySelector<HTMLIFrameElement>("#preview");
if (!logEl || !previewEl) throw new Error("spike layout missing");

function log(message: string, isError = false): void {
  const p = document.createElement("p");
  if (isError) p.className = "err";
  p.textContent = message;
  logEl?.appendChild(p);
}

async function recordToFilesApi(record: Record<string, string | Uint8Array>): Promise<MemFilesApi> {
  const files = new MemFilesApi();
  for (const [path, content] of Object.entries(record)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await files.write(path, [bytes]);
  }
  return files;
}

try {
  logEl.innerHTML = "";

  const scriptTransform = newScriptTransform();
  const swUrl = new URL("./sw-worker.js", document.baseURI).href;

  let baseUrl = "";
  const clientFiles = await recordToFilesApi(clientResources);
  const serverFiles = await recordToFilesApi(serverResources);

  const handler = new SiteBuilder()
    .setFiles("/client", clientFiles, { transform: scriptTransform })
    .setFiles("/server", serverFiles, { transform: scriptTransform })
    .setEndpoint(
      "/api",
      newServerRunner("/server/api/index.ts", () => baseUrl, {
        greeting: "Hello from the typed server",
        service: "site-builder-tsx-spike",
      }),
    )
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();

  const site = await new HostedSiteBuilder()
    .setSiteKey("tsx-spike")
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
