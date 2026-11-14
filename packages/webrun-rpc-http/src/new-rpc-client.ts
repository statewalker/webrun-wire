import { deserializeError, type SerializedError } from "@statewalker/webrun-streams";
import type { Json, JsonObject, RpcMethod } from "./types.js";

export interface NewRpcClientOptions {
  /** Base URL of the RPC endpoint (no trailing slash). */
  baseUrl: string;
  /**
   * Optional fetch override. Defaults to `globalThis.fetch`. Pass a webrun-http
   * handler here to run the client against an in-process server.
   */
  fetch?: (request: Request) => Promise<Response>;
}

export interface RpcClient {
  /**
   * Load (and cache) the service descriptor and return a proxy object whose
   * methods round-trip through the transport.
   */
  loadService<T = Record<string, RpcMethod>>(serviceName: string): Promise<T>;
}

/**
 * Build an RPC client that calls services exposed by {@link newRpcServer}.
 *
 * The descriptor at `GET {baseUrl}/` is fetched lazily on the first
 * `loadService` call and cached for subsequent calls. A failed load is not
 * cached; the next `loadService` call tries again.
 */
export function newRpcClient({
  baseUrl,
  fetch = globalThis.fetch.bind(globalThis),
}: NewRpcClientOptions): RpcClient {
  let apiPromise: Promise<Record<string, Record<string, RpcMethod>>> | null = null;

  const loadApi = async () => {
    const response = await fetch(new Request(baseUrl));
    if (!response.ok) {
      throw new Error(
        `Failed to load services descriptor: ${response.status} ${response.statusText}`,
      );
    }
    const descriptor = (await response.json()) as Record<string, string[]>;
    const services: Record<string, Record<string, RpcMethod>> = {};
    for (const [serviceName, methodNames] of Object.entries(descriptor)) {
      const serviceApi: Record<string, RpcMethod> = {};
      for (const methodName of methodNames) {
        serviceApi[methodName] = newRpcMethod(fetch, baseUrl, serviceName, methodName);
      }
      services[serviceName] = serviceApi;
    }
    return services;
  };

  return {
    async loadService<T = Record<string, RpcMethod>>(serviceName: string): Promise<T> {
      // A failed load is not cached: the next call fetches the descriptor again.
      if (!apiPromise) {
        apiPromise = loadApi().catch((error) => {
          apiPromise = null;
          throw error;
        });
      }
      const apis = await apiPromise;
      const service = apis[serviceName];
      if (!service) throw new Error(`Service ${serviceName} not found`);
      return service as T;
    },
  };
}

function newRpcMethod(
  fetch: (request: Request) => Promise<Response>,
  baseUrl: string,
  serviceName: string,
  methodName: string,
): RpcMethod {
  return async (params: Json = {}, body?: Blob): Promise<Blob | Json> => {
    const url = `${baseUrl}/${serviceName}/${methodName}`;
    const formData = new FormData();
    formData.append("params", JSON.stringify(params));
    if (body) formData.append("body", body);
    const response = await fetch(new Request(url, { method: "POST", body: formData }));
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const json = (await response.json()) as JsonObject | null;
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw new Error("RPC response is not a JSON object");
      }
      if (json.type === "error") throw deserializeError(json as SerializedError);
      if (!response.ok) {
        throw new Error(`RPC call failed: ${response.status} ${response.statusText}`);
      }
      return json.result as Json;
    }
    if (!response.ok) {
      throw new Error(`RPC call failed: ${response.status} ${response.statusText}`);
    }
    return response.blob();
  };
}
