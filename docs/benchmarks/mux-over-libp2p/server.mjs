// Child-process server for the two-process setup. Config JSON in argv[2].
import { memSampler } from "./lib/common.mjs";
import { startServer } from "./lib/server-core.mjs";

const cfg = JSON.parse(process.argv[2] ?? "{}");
const sampler = memSampler(100);
const srv = await startServer(cfg);
const ops = {
  stats: () => srv.stats(),
  mark: () => sampler.mark(),
  summary: (from, to) => sampler.summary(from ?? 0, to ?? undefined),
  gc: () => {
    globalThis.gc?.();
    return true;
  },
  killConnections: () => srv.killConnections(),
};
process.on("message", async ({ id, op, args }) => {
  try {
    process.send({ id, result: await ops[op](...(args ?? [])) });
  } catch (e) {
    process.send({ id, error: String(e?.message ?? e) });
  }
});
process.send({ ready: true, addr: srv.addr });
