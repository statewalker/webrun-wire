import type { MakePair } from "./loopback.js";

/** What {@link measureRunAhead} saw. */
export interface RunAheadMeasurement {
  /** The pair's declared `runAheadBytes` (undefined: it claims no bound). */
  bound?: number;
  /** Bytes produced beyond what the stalled consumer had taken, once the producer stopped. */
  ahead: number;
  /** Every chunk arrived once the consumer resumed. */
  complete: boolean;
  /** Every byte arrived in place: byte k of the stream belongs to chunk floor(k / 4096). */
  intact: boolean;
}

const CHUNK = 4096;
/** The producer counts as stopped after this long without producing. */
const QUIET_MS = 1000;
/** The longest wait for it to stop. */
const SETTLE_LIMIT_MS = 8000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * L6's measurement (spec D17), in one direction: a producer of 4 KiB chunks —
 * chunk i filled with `i & 0xff` — faces a consumer that takes one chunk and
 * stops. Once the producer has made nothing for {@link QUIET_MS}, how far it
 * got ahead is recorded; then the consumer resumes, and every byte is checked
 * in place, whatever chunk boundaries the transport chose. The producer makes
 * enough to exceed a declared bound twice over (a pair with none gets 1 MiB).
 * `response` puts the producer in the handler; `request` puts it in the caller.
 */
export async function measureRunAhead(
  makePair: MakePair,
  direction: "response" | "request",
): Promise<RunAheadMeasurement> {
  const pair = await makePair();
  const bound = pair.runAheadBytes;
  const count =
    bound === undefined ? 256 : Math.max(64, Math.ceil((2 * bound + 64 * 1024) / CHUNK));
  let produced = 0;
  const producer = async function* () {
    for (let i = 0; i < count; i++) {
      produced++;
      yield new Uint8Array(CHUNK).fill(i & 0xff);
    }
  };
  /** Checks bytes as they stream past, at their offsets in the whole stream. */
  const checker = () => {
    let offset = 0;
    let intact = true;
    return {
      take(chunk: Uint8Array) {
        for (let j = 0; j < chunk.byteLength; j++, offset++) {
          if (chunk[j] !== (Math.floor(offset / CHUNK) & 0xff)) intact = false;
        }
      },
      get bytes() {
        return offset;
      },
      get intact() {
        return intact;
      },
    };
  };
  const settled = async () => {
    const start = Date.now();
    let last = produced;
    let quietSince = Date.now();
    while (Date.now() - quietSince < QUIET_MS && Date.now() - start < SETTLE_LIMIT_MS) {
      await delay(50);
      if (produced !== last) {
        last = produced;
        quietSince = Date.now();
      }
    }
  };
  try {
    if (direction === "response") {
      await pair.serve(async function* (input) {
        for await (const _ of input);
        yield* producer();
      });
      const { call, close } = await pair.connect();
      try {
        const seen = checker();
        const it = call([])[Symbol.asyncIterator]();
        const first = await it.next();
        if (!first.done) seen.take(first.value);
        await settled();
        const ahead = produced * CHUNK - seen.bytes;
        for (let r = await it.next(); !r.done; r = await it.next()) seen.take(r.value);
        return { bound, ahead, complete: seen.bytes === count * CHUNK, intact: seen.intact };
      } finally {
        await close();
      }
    }
    const seen = checker();
    let resume!: () => void;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    await pair.serve(async function* (input) {
      let first = true;
      for await (const chunk of input) {
        seen.take(chunk);
        if (first) {
          first = false;
          yield new Uint8Array([1]); // the first chunk arrived
          await gate;
        }
      }
      yield new Uint8Array([2]); // the input ended
    });
    const { call, close } = await pair.connect();
    try {
      const it = call(producer())[Symbol.asyncIterator]();
      await it.next();
      await settled();
      const ahead = produced * CHUNK - seen.bytes;
      resume();
      for (let r = await it.next(); !r.done; r = await it.next());
      return { bound, ahead, complete: seen.bytes === count * CHUNK, intact: seen.intact };
    } finally {
      await close();
    }
  } finally {
    await pair.close();
  }
}
