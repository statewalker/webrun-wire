import { defineConfig } from "rolldown";

// EXCEPTION to the workspace-wide externals policy in ../../rolldown.preset.js.
//
// Every other package externalises its declared dependencies. This one must
// not: its own shipped HTML loads the bundle straight from a static host with
// no import map — `public-relay/relay.html`, `demo/demo-1.html` and
// `demo/demo-2.html` all do `import ... from "../dist/index.js"` — and the two
// IIFE service-worker runtimes are loaded through classic `importScripts(...)`,
// which cannot resolve a bare specifier at all. Bare specifiers surviving into
// these outputs would break the relay.
//
// The cost is a duplicated copy of `@statewalker/webrun-streams` in this
// bundle, so do not rely on `instanceof` across this package's boundary.
//
// Every output is a single, fully self-contained file:
// - ESM bundles (index.js, sw.js) can be loaded from `<script type="module">`
//   with no import map, no bundler, and no sibling chunk files.
// - IIFE bundles (relay-sw.js, sw-worker.js) can be loaded from a classic
//   `importScripts(...)` loader script.
//
// To get "no chunk splitting" with multiple entries, each entry gets its
// own rolldown config. Duplicated code across bundles is accepted in
// exchange for truly standalone output.

const entries = [
  { name: "index", input: "src/index.ts", format: "esm" },
  { name: "sw", input: "src/sw.ts", format: "esm" },
  { name: "relay-sw", input: "src/relay-sw.ts", format: "iife" },
  { name: "sw-worker", input: "src/sw-worker.ts", format: "iife" },
];

export default defineConfig(
  entries.map(({ name, input, format }) => ({
    input,
    output: { file: `dist/${name}.js`, format },
    transform:
      format === "iife"
        ? {
            // IIFE has no `import.meta`; inside a SW `self.location.href` is
            // the URL of the SW script — same base the page-side code uses.
            define: { "import.meta.url": "self.location.href" },
          }
        : undefined,
    treeshake: true,
  })),
);
