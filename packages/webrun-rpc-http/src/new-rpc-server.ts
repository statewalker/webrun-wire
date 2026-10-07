import { serializeError } from "@statewalker/webrun-streams";
import { getInstanceMethods } from "./get-instance-methods.js";
import type { Json, JsonObject, RpcMethod } from "./types.js";

export interface NewRpcServerOptions {
  /**
   * URL prefix under which the RPC endpoints are mounted. A trailing slash is
   * stripped. Empty (the default) mounts at the origin root.
   */
  path?: string;
}

type ServiceIndex = Record<string, Record<string, RpcMethod>>;

/**
 * Build a webrun-http `(Request) ⇒ Response` handler that exposes every method
 * of every service as an HTTP endpoint.
 *
 * Wire format:
 * - `GET  {path}/`                               → `{ [service]: [methodName, ...] }`
 * - `GET  {path}/{service}`                      → `[methodName, ...]`
 * - `GET  {path}/{service}/{method}?a.b=c`       → calls the method with `{ a: { b: "c" } }`
 * - `POST {path}/{service}/{method}` with multipart/form-data (`params` JSON
 *   + optional `body` Blob) → calls the method with the decoded args
 *
 * Results are returned as `{ type: "json", result }` JSON, or as an
 * `application/octet-stream` blob when the method returns a `Blob`. Errors
 * are serialized to `{ type: "error", message, stack, ... }` JSON.
 */
export function newRpcServer(
  services: Record<string, object>,
  { path = "" }: NewRpcServerOptions = {},
): (request: Request) => Promise<Response> {
  const prefix = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = buildServiceIndex(services);

  return async (request: Request): Promise<Response> => {
    try {
      const route = splitRequestPath(request, prefix);
      if (!route) return errorResponse(new Error("Not found"), 404);
      const { serviceName, methodName, subPath } = route;
      if (request.method === "GET" && !serviceName) {
        return jsonResponse(describeServices(index));
      }
      if (request.method === "GET" && serviceName && !methodName) {
        return jsonResponse(listMethods(index, serviceName));
      }
      if ((request.method === "GET" || request.method === "POST") && serviceName && methodName) {
        const { params, body } = await parseCallArgs(request);
        const result = await invoke(index, serviceName, methodName, subPath, params, body);
        return result instanceof Blob ? blobResponse(result) : jsonResponse(result);
      }
      return errorResponse(new Error("Not found"), 404);
    } catch (error) {
      return errorResponse(error as Error, 500);
    }
  };
}

function buildServiceIndex(services: Record<string, object>): ServiceIndex {
  const index: ServiceIndex = {};
  for (const [serviceName, service] of Object.entries(services)) {
    const methods = getInstanceMethods(service);
    const methodsIndex: Record<string, RpcMethod> = {};
    for (const [methodName, method] of Object.entries(methods)) {
      methodsIndex[methodName] = async (params, body) =>
        (await method.call(service, params, body)) as Blob | Json;
    }
    index[serviceName] = methodsIndex;
  }
  return index;
}

interface ParsedPath {
  serviceName?: string;
  methodName?: string;
  subPath: string;
}

function splitRequestPath(request: Request, prefix: string): ParsedPath | null {
  const pathname = new URL(request.url).pathname;
  if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const rest = pathname.substring(prefix.length + 1);
  const [serviceName = "", methodName = "", ...tail] = rest.split("/");
  return {
    serviceName: serviceName || undefined,
    methodName: methodName || undefined,
    subPath: tail.join("/"),
  };
}

async function parseCallArgs(request: Request): Promise<{ params: Json; body?: Blob }> {
  if (request.method === "GET") {
    return { params: parseQueryParams(new URL(request.url).searchParams) };
  }
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.startsWith("multipart/form-data")) {
    const formData = await request.formData();
    let params: Json = {};
    if (formData.has("params")) {
      params = JSON.parse(formData.get("params") as string) as Json;
    }
    const body = formData.has("body") ? (formData.get("body") as Blob) : undefined;
    return { params, body };
  }
  const body = request.body ? await request.blob() : undefined;
  return { params: {}, body };
}

/**
 * Expand dot-separated query keys (`a.b=c`) into nested JSON objects.
 * Repeated keys overwrite rather than merging — same as the original.
 */
function parseQueryParams(search: URLSearchParams): JsonObject {
  const root: JsonObject = {};
  for (const [key, value] of search.entries()) {
    const segments = key.split(".");
    let cursor: JsonObject = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const existing = cursor[seg];
      if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as JsonObject;
    }
    cursor[segments[segments.length - 1]] = value;
  }
  return root;
}

async function invoke(
  index: ServiceIndex,
  serviceName: string,
  methodName: string,
  subPath: string,
  params: Json,
  body?: Blob,
): Promise<Json | Blob> {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    (params as JsonObject).$path = subPath;
  }
  const method = index[serviceName]?.[methodName];
  if (!method) {
    throw new Error(`Method ${methodName} not found in service ${serviceName}`);
  }
  try {
    const result = await method(params, body);
    return result instanceof Blob ? result : ({ type: "json", result } as JsonObject);
  } catch (error) {
    return { type: "error", ...serializeError(error as Error) } as JsonObject;
  }
}

function describeServices(index: ServiceIndex): JsonObject {
  const out: JsonObject = {};
  for (const [name, methods] of Object.entries(index)) {
    out[name] = Object.keys(methods);
  }
  return out;
}

function listMethods(index: ServiceIndex, serviceName: string): Json[] {
  const svc = index[serviceName];
  return svc ? Object.keys(svc) : [];
}

function jsonResponse(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function blobResponse(body: Blob): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

function errorResponse(error: Error, status: number): Response {
  const body: JsonObject = { type: "error", ...serializeError(error) };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
