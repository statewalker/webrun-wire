import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Same-origin ServiceWorker mode: serve the pre-built SW runtime at
// `/sw-worker.js` so its scope is the site root (`/`). The site-builder-demo
// uses vite-plugin-static-copy for this, but its absolute-path semantics
// land the file at `dist/node_modules/...` instead of `dist/sw-worker.js`.
// A 10-line inline plugin sidesteps that.
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
  // Emit relative asset paths (`./assets/…`) instead of origin-absolute
  // (`/assets/…`) so the built `dist/` folder works when hosted under an
  // arbitrary sub-path or opened with `file://`.
  base: "./",
  build: {
    target: "esnext",
  },
  server: {
    port: 5174,
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
