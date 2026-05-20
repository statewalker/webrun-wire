import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Same-origin ServiceWorker mode: serve the pre-built SW runtime at
// `/sw-worker.js` so its scope is the site root (`/`). Mirrors the
// site-builder-tsx-spike pattern — see that app's vite.config.js for the
// rationale on the inline plugin vs. vite-plugin-static-copy.
const swRuntime = fileURLToPath(
  new URL("./node_modules/@statewalker/webrun-http-browser/dist/sw-worker.js", import.meta.url),
);

function serveSwWorker() {
  return {
    name: "serve-sw-worker",
    configureServer(server) {
      server.middlewares.use("/sw-worker.js", (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Service-Worker-Allowed", "/");
        res.end(readFileSync(swRuntime));
      });
    },
    writeBundle(options) {
      const dest = resolve(options.dir ?? "dist", "sw-worker.js");
      copyFileSync(swRuntime, dest);
    },
  };
}

export default defineConfig({
  plugins: [serveSwWorker()],
  base: "./",
  build: {
    target: "esnext",
  },
  server: {
    port: 5175,
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
