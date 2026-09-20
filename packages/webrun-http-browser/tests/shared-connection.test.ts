/**
 * TWO SERVICES ON ONE RELAY CONNECTION — the shape mounts exist for: an app at
 * `/` and a mesh gateway at `/peers/`, registered from one page, over one
 * port, through one relay iframe.
 *
 * The defect this pins: `registerConnectionsHandler` installed its CONNECT
 * handler with no key filter, so EVERY registered service answered EVERY
 * CONNECT. `handleChannelCalls` runs each listener and gives each the same
 * reply port and the same transferred stream port, and `callChannel` resolves
 * on the first reply — so which service served a request was a race, and both
 * wrote their response onto the one channel the worker was reading.
 *
 * The assertions are about WHO RECEIVED WHAT, never about who answered first:
 * a race asserted on timing shows up as a flaky pass, which is worse than no
 * test at all. `seen` is deterministic — under the defect both handlers
 * receive both requests, whoever wins.
 */

import { describe, expect, it } from "vitest";
import { callChannel, handleChannelCalls } from "../src/core/data-calls.js";
import type { MessageTarget } from "../src/core/message-target.js";
import { sendHttpRequest } from "../src/http/http-send-recieve.js";
import { initHttpService } from "../src/relay/index.js";

function asTarget(port: MessagePort): MessageTarget {
  return port as unknown as MessageTarget;
}

describe("two services on one relay connection", () => {
  it("routes each CONNECT to the service it names, and to no other", async () => {
    // `page` is the side a host's `initHttpService` talks to; `worker` stands
    // in for the relay ServiceWorker at the other end of the relay bridge.
    const { port1: page, port2: worker } = new MessageChannel();
    const stops: Array<() => unknown> = [];
    handleChannelCalls(asTarget(worker), "REGISTER", async () => true);
    handleChannelCalls(asTarget(worker), "UNREGISTER", async () => true);

    const seen: Record<string, string[]> = { app: [], mesh: [] };
    const mounts = [
      { key: "app", path: "/" },
      { key: "mesh", path: "/peers/" },
    ];
    try {
      for (const { key, path } of mounts) {
        stops.push(
          await initHttpService(
            async (request) => {
              const { pathname } = new URL(request.url);
              seen[key].push(pathname);
              return new Response(`${key}:${pathname}`);
            },
            { key, path, port: asTarget(page) },
          ),
        );
      }

      /** Exactly what the relay worker does with a fetch it has routed to `key`. */
      async function callService(key: string, url: string): Promise<Response> {
        const channel = new MessageChannel();
        const accepted = await callChannel<boolean>(
          asTarget(worker),
          "CONNECT",
          { type: "http", key },
          channel.port2,
        );
        if (!accepted) throw new Error(`CONNECT for "${key}" was refused`);
        return await sendHttpRequest(asTarget(channel.port1), new Request(url));
      }

      const app = await callService("app", "https://relay.test/index.html");
      expect(await app.text()).toBe("app:/index.html");

      const mesh = await callService("mesh", "https://relay.test/peers/12D3Koo/llm");
      expect(await mesh.text()).toBe("mesh:/peers/12D3Koo/llm");

      // Neither service saw the other's request. Under the unfixed code both
      // handlers see both paths, whichever one's response won the race.
      expect(seen).toEqual({ app: ["/index.html"], mesh: ["/peers/12D3Koo/llm"] });
    } finally {
      for (const stop of stops) await stop();
      page.close();
      worker.close();
    }
  });
});
