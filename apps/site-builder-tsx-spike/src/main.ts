import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { newScriptTransform } from "./script-transform.js";
import { clientResources } from "./site.js";

const logEl = document.querySelector<HTMLDivElement>("#log");
const previewEl = document.querySelector<HTMLIFrameElement>("#preview");
if (!logEl || !previewEl) throw new Error("spike layout missing");

function log(message: string, isError = false): void {
  const p = document.createElement("p");
  if (isError) p.className = "err";
  p.textContent = message;
  logEl?.appendChild(p);
}

try {
  logEl.innerHTML = "";

  const site = await new HostedSiteBuilder()
    .setSiteKey("tsx-spike")
    .setFiles("/client", clientResources, { transform: newScriptTransform() })
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();
  log(`Site mounted at ${site.baseUrl}`);

  previewEl.src = `${site.baseUrl}client/index.html`;
  log(`iframe → ${previewEl.src}`);
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`, true);
  console.error(error);
}
