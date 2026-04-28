// Static resources for the spike site — both client AND server are real
// TypeScript with type annotations. Both go through the same
// `newScriptTransform()` filter via the `/client` and `/server` mounts,
// proving the transform applies uniformly to:
//
//   - `client/main.tsx`       — TSX with JSX (transforms: typescript + jsx)
//   - `client/format.ts`      — typed helper imported by main.tsx
//   - `server/api/index.ts`   — typed Request → Response handler
//
// The client form calls `/api?name=…`, which is dispatched through
// `setServerRunner("/api", "/server/api/index.ts")` — that dynamic-imports
// the `.ts` URL, which the SW → MemFilesApi → transform pipeline returns
// as `Content-Type: text/javascript`. The browser's native module loader
// runs the transpiled handler and serves the response back through fetch.

export const clientResources: Record<string, string> = {
  "/index.html": `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>tsx spike</title>
  <link rel="stylesheet" href="./style.css">
</head><body>
  <h2>TS/TSX transpiled in the browser — client + server</h2>
  <p>
    Client (<code>main.tsx</code>, typed + JSX) calls
    <code>../api?name=…</code>. The endpoint runs
    <code>server/api/index.ts</code> — a typed
    <code>Request → Response</code> handler — also transpiled on the fly.
  </p>
  <label>Name: <input id="name" value="World"></label>
  <div id="out">…</div>
  <script type="module" src="./main.tsx"></script>
</body></html>`,
  "/style.css": `body { font-family: system-ui, sans-serif; margin: 1rem; }
h2 { color: navy; }
code { background: #f4f4f5; padding: 0 0.25rem; border-radius: 0.2rem; }
input { font-size: 1rem; padding: 0.2rem 0.4rem; }
#out { background: #f4f4f5; padding: 0.5rem; border-radius: 0.25rem;
       margin-top: 0.5rem; min-height: 2rem; white-space: pre-wrap;
       font-family: ui-monospace, monospace; font-size: 0.85rem; }`,
  "/format.ts": `// Typed helper imported by main.tsx — proves cross-file TS imports
// work through the transform.
export interface ApiResponse {
  message: string;
  at: string;
  now: string;
  receivedName: string;
}

export function formatResponse(data: ApiResponse): string {
  return [
    \`message: \${data.message}\`,
    \`name:    \${data.receivedName}\`,
    \`path:    \${data.at}\`,
    \`time:    \${data.now}\`,
  ].join("\\n");
}
`,
  "/main.tsx": `// Typed TSX with JSX — proves the typescript+jsx transform branch.
// Imports a typed helper from a sibling .ts file via explicit extension.
import { formatResponse } from "./format.ts";
import type { ApiResponse } from "./format.ts";

function h(tag: string, _props: unknown, ...children: Array<string | Node>): HTMLElement {
  const el = document.createElement(tag);
  el.append(...children);
  return el;
}

const input = document.querySelector<HTMLInputElement>("#name");
const out = document.querySelector<HTMLDivElement>("#out");
if (!input || !out) throw new Error("spike client layout missing");

async function refresh(): Promise<void> {
  // Client is hosted at /<key>/client/, API at /<key>/api — one level up.
  const response = await fetch(\`../api?name=\${encodeURIComponent(input!.value)}\`);
  if (!response.ok) {
    out!.replaceChildren(<p>API error: {String(response.status)}</p>);
    return;
  }
  const data = (await response.json()) as ApiResponse;
  out!.replaceChildren(<pre>{formatResponse(data)}</pre>);
}

input.addEventListener("input", refresh);
refresh();
console.log("[tsx-spike] client wired");
`,
};

export const serverResources: Record<string, string> = {
  "/api/index.ts": `// Typed Request → Response handler. Loaded via setServerRunner, which
// dynamic-imports this module's URL through the SW + transform pipeline.
// The .ts extension is irrelevant to the browser — it follows the
// Content-Type response header (text/javascript) emitted by the transform.

interface ApiResponse {
  message: string;
  at: string;
  now: string;
  receivedName: string;
}

export default async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const name: string = url.searchParams.get("name") ?? "anonymous";
  const payload: ApiResponse = {
    message: \`Hello from the typed server, \${name}!\`,
    at: url.pathname,
    now: new Date().toISOString(),
    receivedName: name,
  };
  return Response.json(payload);
}
`,
};
