import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Serve the prebuilt SW runtime from `@statewalker/webrun-http-browser` at
// `/sw-worker.js` so its scope is the site root. See site-builder-tsx-spike
// for the same pattern.
const swRuntime = fileURLToPath(
  new URL("./node_modules/@statewalker/webrun-http-browser/dist/sw-worker.js", import.meta.url),
);

function serveSwWorker() {
  return {
    name: "serve-sw-worker",
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          fn: (
            req: unknown,
            res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void },
          ) => void,
        ) => void;
      };
    }) {
      server.middlewares.use("/sw-worker.js", (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Service-Worker-Allowed", "/");
        res.end(readFileSync(swRuntime));
      });
    },
    writeBundle(options: { dir?: string }) {
      const dest = resolve(options.dir ?? "dist", "sw-worker.js");
      copyFileSync(swRuntime, dest);
    },
  };
}

export default defineConfig({
  plugins: [serveSwWorker()],
  base: "./",
  build: { target: "esnext" },
  server: { port: 5176 },
});
