// The content script: a byte relay between the page's MessagePort and a
// chrome.runtime.Port to the service worker. It never decodes the multiplexer.
import { chromePortPipe, messagePortPipe, relayPipes } from "../../../src/index.ts";

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "webrun-connect") return;
  const channel = new MessageChannel();
  const port = chrome.runtime.connect({ name: "webrun" });
  relayPipes(
    messagePortPipe(channel.port1, { name: "cs<->page" }),
    chromePortPipe(port, { name: "cs<->sw" }),
  );
  window.postMessage({ type: "webrun-connected", id: event.data.id }, "*", [channel.port2]);
});
window.postMessage({ type: "webrun-extension-ready" }, "*");
