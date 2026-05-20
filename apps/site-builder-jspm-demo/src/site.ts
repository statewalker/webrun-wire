// In-memory source for the demo's "user-authored" project. Both client and
// server use bare specifiers (`react`, `react-dom/client`, `zod`); the
// JspmResolver discovers them via es-module-lexer and resolves them via
// @jspm/generator into a same-origin /external/ mount.
//
// One package.json shared between client and server pins every dep.

export const sharedPackageJson = JSON.stringify(
  {
    name: "site-builder-jspm-demo-source",
    private: true,
    type: "module",
    dependencies: {
      react: "^18",
      "react-dom": "^18",
      zod: "^4",
      leaflet: "^1.9",
      htl: "*",
      kysely: "*",
      astro: "*",
    },
  },
  null,
  2,
);

export const clientResources: Record<string, string> = {
  "/package.json": sharedPackageJson,
  "/index.html": `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>jspm-demo client</title>
  <link rel="stylesheet" href="./style.css">
</head><body>
  <h2>React in the browser — bare specifiers resolved via JSPM</h2>
  <p>
    Client (<code>main.tsx</code>) imports React with ordinary
    <code>import</code> statements. The served bytes have every
    specifier rewritten to a relative <code>../external/…</code> URL.
  </p>
  <label>Name: <input id="name" value="World"></label>
  <div id="root"></div>
  <script type="module" src="./main.js"></script>
</body></html>`,
  "/style.css": `body { font-family: system-ui, sans-serif; margin: 1rem; }
h2 { color: navy; }
code { background: #f4f4f5; padding: 0 0.25rem; border-radius: 0.2rem; }
input { font-size: 1rem; padding: 0.2rem 0.4rem; }
#root { background: #f4f4f5; padding: 0.5rem; border-radius: 0.25rem;
        margin-top: 0.5rem; min-height: 3rem; font-family: ui-monospace, monospace;
        font-size: 0.85rem; }
.error { color: #b91c1c; }`,
  "/main.tsx": `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import * as htl from "htl";

interface ApiResponse {
  greeting: string;
  receivedName: string;
  now: string;
}

interface ApiError {
  error: { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
}

function isError(payload: ApiResponse | ApiError): payload is ApiError {
  return (payload as ApiError).error !== undefined;
}

function App(): JSX.Element {
  const [name, setName] = useState<string>("World");
  const [payload, setPayload] = useState<ApiResponse | ApiError | null>(null);

  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>("#name");
    if (!input) return;
    input.value = name;
    const onInput = (): void => setName(input.value);
    input.addEventListener("input", onInput);
    return (): void => input.removeEventListener("input", onInput);
  }, [name]);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const res = await fetch(\`../api?name=\${encodeURIComponent(name)}\`);
      const data = (await res.json()) as ApiResponse | ApiError;
      if (!cancelled) setPayload(data);
    })();
    return (): void => {
      cancelled = true;
    };
  }, [name]);

  if (payload === null) return <p>Loading…</p>;
  if (isError(payload)) {
    return <p className="error">Validation failed: {JSON.stringify(payload.error)}</p>;
  }
  return (
    <div>
      <p><strong>{payload.greeting}</strong></p>
      <p>received name: {payload.receivedName}</p>
      <p>at: {payload.now}</p>
    </div>
  );
}

const rootEl = document.querySelector("#root");
if (!rootEl) throw new Error("client root missing");
createRoot(rootEl).render(<App />);
console.log("[jspm-demo] Leaflet version:", L.version);
console.log("[jspm-demo] htl version:", htl);
console.log("[jspm-demo] client wired");
`,
};

export const serverResources: Record<string, string> = {
  "/package.json": sharedPackageJson,
  "/api/index.ts": `// Typed (Request, env) -> Response handler. The dynamic import in
// newServerRunner pulls this URL through the SW; the served bytes have
// every bare specifier rewritten to a relative ../external/<pkg>@<v>/
// path, so the host page realm runs it directly without an import map.
//
// With the esm.sh provider, this module also pulls Astro and zod 4 —
// both fetched and mirrored into /external/ before the iframe mounts.
import { z } from "zod";
import * as Kysely from "kysely";
import * as Astro from "astro";

const querySchema = z.object({
  name: z.string().min(1, "name must be non-empty"),
});

interface ServerEnv {
  params: Record<string, string>;
  service: string;
}

export default async function handle(
  request: Request,
  env: ServerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    name: url.searchParams.get("name") ?? "",
  });
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  console.log("[jspm-demo] server env=", env, "name=", parsed.data.name);
  console.log("[jspm-demo] Kysely exports:", Object.keys(Kysely).length, "names");
  console.log("[jspm-demo] Astro exports:", Object.keys(Astro).length, "names");
  return Response.json({
    greeting: \`Hello, \${parsed.data.name}! (service=\${env.service})\`,
    receivedName: parsed.data.name,
    now: new Date().toISOString(),
    libs: {
      zod: "v4 (resolved via esm.sh when #provider=esm.sh)",
      astroExports: Object.keys(Astro).slice(0, 5),
      kyselyExports: Object.keys(Kysely).slice(0, 5),
    },
  });
}
`,
};
