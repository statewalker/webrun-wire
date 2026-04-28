// Static resources for the spike site.
//
// The interesting bits live in `/client/main.tsx` and `/client/greeter.ts`:
// both are TypeScript source with type annotations that the browser cannot
// run as-is. The `ServeFilesOptions.transform` filter (see script-transform.ts)
// transpiles them to plain JS before the response leaves the SW.
//
// The TSX file imports the TS file via an explicit `.ts` extension — native
// browser ESM resolution requires the extension. The transform fires on
// either extension and serves both as `Content-Type: text/javascript`.

export const clientResources: Record<string, string> = {
  "/index.html": `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>tsx spike</title>
  <link rel="stylesheet" href="./style.css">
</head><body>
  <h2>TS/TSX transpiled in the browser</h2>
  <p>
    Below: a single DOM node populated by <code>main.tsx</code>, which
    imports a typed helper from <code>greeter.ts</code>. Both files are
    real TypeScript — the response was transpiled on the fly.
  </p>
  <div id="out">…</div>
  <script type="module" src="./main.tsx"></script>
</body></html>`,
  "/style.css": `body { font-family: system-ui, sans-serif; margin: 1rem; }
h2 { color: navy; }
code { background: #f4f4f5; padding: 0 0.25rem; border-radius: 0.2rem; }
#out { background: #f4f4f5; padding: 0.5rem; border-radius: 0.25rem; min-height: 2rem; }`,
  "/greeter.ts": `// Real TypeScript — type annotations would crash the browser without
// a transpile step.
export interface Greeting {
  text: string;
  at: string;
}

export function greet(name: string): Greeting {
  return {
    text: \`Hello, \${name}! (from typed greeter.ts)\`,
    at: new Date().toISOString(),
  };
}
`,
  "/main.tsx": `// Real TSX — type annotations + JSX. Sucrase strips the types and
// rewrites the JSX to \`h(...)\` calls (classic pragma) before this runs.
// The hand-rolled \`h\` factory below is what JSX compiles to.
import { greet } from "./greeter.ts";
import type { Greeting } from "./greeter.ts";

function h(tag: string, _props: unknown, ...children: Array<string | Node>): HTMLElement {
  const el = document.createElement(tag);
  el.append(...children);
  return el;
}

const out = document.querySelector<HTMLDivElement>("#out");
if (!out) throw new Error("no #out element");

function render(g: Greeting): void {
  const node = <p>{g.text} @ {g.at}</p>;
  out!.replaceChildren(node);
}

render(greet("spike"));
console.log("[tsx-spike] greeted");
`,
};
