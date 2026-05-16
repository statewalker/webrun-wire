import type { HttpHandler } from "@statewalker/webrun-http-streams";
import { handleHttpRequests, sendHttpRequest } from "../http/http-send-recieve.js";
import {
  SwPortDispatcher,
  type SwPortDispatcherOptions,
  SwPortHandler,
  type SwPortHandlerOptions,
} from "./sw-dispatcher.js";

export interface SwHttpAdapterOptions extends Omit<SwPortHandlerOptions, "bindPort"> {
  bindPort?: SwPortHandlerOptions["bindPort"];
}

export interface SwHttpRegistration {
  baseUrl: string;
  prefix: string;
  remove(): Promise<void>;
}

export class SwHttpAdapter extends SwPortHandler {
  private readonly _handlers = new Map<string, HttpHandler>();
  private _cleanupRequestChannel?: () => void;

  constructor(options: SwHttpAdapterOptions) {
    super({
      bindPort: () => {},
      ...options,
    });
  }

  protected override async _setCommunicationPort(port: MessagePort): Promise<void> {
    this._cleanupRequestChannel?.();
    this._cleanupRequestChannel = handleHttpRequests(port, this._handleHttpRequest.bind(this));
  }

  private async _handleHttpRequest(request: Request): Promise<Response> {
    const requestUrl = request.url;
    for (const [urlPrefix, handler] of this._handlers) {
      if (requestUrl.indexOf(urlPrefix) === 0) {
        return handler(request);
      }
    }
    return new Response(null, { status: 404, statusText: "Error 404: Not found" });
  }

  /**
   * Registers an HTTP handler on a prefix. Returns the resulting base URL and a
   * disposer.
   */
  async register(prefix: string, handler: HttpHandler): Promise<SwHttpRegistration> {
    const cleanPrefix = `./${(prefix ?? "").replace(/^[./]+/, "")}`;
    const baseUrl = `${new URL(cleanPrefix, this.rootUrl)}`;
    this._handlers.set(baseUrl, handler);
    const handlers = this._handlers;
    return {
      baseUrl,
      prefix: cleanPrefix,
      async remove() {
        handlers.delete(baseUrl);
      },
    };
  }
}

export class SwHttpDispatcher extends SwPortDispatcher {
  start(): void {
    super.start();
    this.self.addEventListener("fetch", this._handleFetchEvent.bind(this));
  }

  private _handleFetchEvent(event: FetchEvent): void {
    event.respondWith(
      (async (): Promise<Response> => {
        const request = event.request;
        try {
          const requestUrl = request.url;
          const rootUrl = this.scope;
          if (requestUrl.indexOf(rootUrl) === 0) {
            const key = requestUrl.substring(rootUrl.length).replace(/^\/?([^/]+).*$/, "$1");
            const channelInfo = await this.loadChannelInfo(key);
            if (channelInfo?.port) {
              return await sendHttpRequest(channelInfo.port, request);
            }
            // Key was registered at some point on this SW but has no live
            // handler right now (owner tab closed). Return 404 instead of
            // falling through to the network — the alternative (a dev
            // server's SPA fallback) serves the app shell for every site
            // URL and creates a confusing refresh-loop where stale tabs
            // keep resurrecting registrations.
            if (this.isClaimedKey(key)) {
              return new Response(null, {
                status: 404,
                statusText: "Not Found (no active handler)",
              });
            }
          }
          // URL is outside scope, or the first segment is unrelated to any
          // registered site (Vite's /assets/*, /favicon.ico, etc.) — pass
          // the event's Request straight through. Reconstructing it drops
          // `mode`, which makes the constructor throw
          // `'only-if-cached' can be set only with 'same-origin' mode` for
          // navigation-style requests Chrome issues with that cache mode.
          return await fetch(request);
        } catch (error) {
          console.error(error);
          return new Response(null, {
            status: 500,
            statusText: "Error 500: Internal error",
          });
        }
      })(),
    );
  }
}

export function startHttpDispatcher(options: SwPortDispatcherOptions): () => void {
  const dispatcher = new SwHttpDispatcher(options);
  dispatcher.start();
  return () => {
    void dispatcher.stop();
  };
}
