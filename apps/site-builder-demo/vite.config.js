import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Same-origin ServiceWorker mode (no relay): serve the pre-built SW runtime
// at `/sw-worker.js` so its scope is the site root (`/`) — required by
// `SwHttpAdapter.start()` which waits for the controller.
//
// This was previously done with `vite-plugin-static-copy`, but its dev-mode
// middleware does not register correctly when `src` is an absolute path
// (the file lands at `dist/node_modules/...` instead of `dist/sw-worker.js`,
// and dev mode returns the SPA fallback for `/sw-worker.js`). A 10-line
// inline plugin sidesteps both bugs.
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
    // src/main.ts uses top-level await; modern target lets esbuild keep it.
    target: "esnext",
  },
  server: {
    port: 5173,
    fs: {
      // pnpm symlinks webrun-http-browser; allow the workspace root so the
      // pre-built SW runtime is readable.
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
