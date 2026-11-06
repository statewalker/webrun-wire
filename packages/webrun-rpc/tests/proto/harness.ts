// PROTOTYPE (proto/pipelining, T-1 / T-2): throwaway benchmark harness.

import type { Duplex } from "@statewalker/webrun-streams";
import { connect, overPipe, serve } from "../../src/connect-serve.js";
import { structuredCodec } from "../../src/structured-codec.js";

export type Mode = "today" | "h1" | "h2";

export interface Link {
  call: Duplex;
  close(): Promise<void>;
}

/** connect/serve over overPipe + structuredCodec on a real MessageChannel. */
export async function newLink(
  mode: Mode,
  window: number | undefined,
  handler: Duplex,
): Promise<Link> {
  const ch = new MessageChannel();
  const caps = mode === "today" ? undefined : [mode === "h1" ? "pipeline-msg" : "pipeline-call"];
  const opts = mode === "today" ? {} : { window, caps };
  const teardown = await serve(
    { mux: overPipe(ch.port2, { codec: structuredCodec, side: "responder", ...opts } as never) },
    handler,
  );
  const { call, close } = await connect({
    mux: overPipe(ch.port1, { codec: structuredCodec, side: "initiator", ...opts } as never),
  });
  return {
    call,
    async close() {
      await close();
      await teardown();
      ch.port1.close();
      ch.port2.close();
    },
  };
}

/** A handler that ignores its input and answers `count` chunks of `size` bytes. */
export function bodyHandler(size: number, count: number): Duplex {
  const chunk = new Uint8Array(size).fill(7);
  return async function* (input) {
    // drain input
    for await (const _ of input) {
    }
    for (let i = 0; i < count; i++) yield chunk;
  };
}

export async function readBody(link: Link): Promise<number> {
  let bytes = 0;
  for await (const c of link.call([new Uint8Array([1])])) bytes += c.byteLength;
  return bytes;
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

/** MB/s of one body of `count` x `size`, median of `runs`. */
export async function throughput(
  mode: Mode,
  window: number | undefined,
  size: number,
  count: number,
  runs = 3,
): Promise<number> {
  const results: number[] = [];
  for (let r = 0; r < runs; r++) {
    const link = await newLink(mode, window, bodyHandler(size, count));
    // warm-up
    await readBody(link);
    const t0 = performance.now();
    const bytes = await readBody(link);
    const ms = performance.now() - t0;
    if (bytes !== size * count) throw new Error(`short body: ${bytes} of ${size * count}`);
    results.push(bytes / 1024 / 1024 / (ms / 1000));
    await link.close();
  }
  return median(results);
}
