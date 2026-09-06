# Plan C1 — the byte codec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `multiplexPort` a `PortCodec` that works over a transport carrying bytes, and prove
the whole new stack passes L0–L6 over one — so that C2 can migrate `-ws`, `-livekit` and `-peerjs`
onto a codec that is already known to work.

**Architecture:** `structuredCodec` posts envelopes unencoded, which works only where messages are
structured values. `msgpackCodec` is its byte-transport sibling: one envelope in, one msgpack frame
out, one `postMessage` per envelope. No length prefix — every target transport preserves message
boundaries — and no transferables, because the payload is already inside the bytes. It lives in
`@statewalker/webrun-msgpack` with a **type-only** import of `PortCodec`, so `webrun-rpc` never
gains a msgpack dependency.

**Tech Stack:** TypeScript (ES2022, `strict`, DOM lib), `@ygoe/msgpack`, vitest 4, biome, pnpm
workspaces, changesets. Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-09-05-port-multiplexer-design.md` — read it, in particular
D6 (pluggable codec), D10 (message size is data), D16 (the msgpack-expressible subset), D20
(adapters depend on nothing in this repository) and the Sequencing section's C1 entry, which this
plan implements.

**Prior findings you are expected to have read.** They are short, and each records a mistake this
plan is shaped to avoid:
- `docs/superpowers/2026-09-05-port-mux-layer-1-findings.md`
- `docs/superpowers/2026-09-05-port-mux-layer-2a-findings.md`
- `docs/superpowers/2026-09-06-port-mux-layer-2b-findings.md` — especially "Where this plan was
  wrong". Five assertions in that plan were satisfied whether or not the machinery worked, and not
  one was caught by reading.

---

## Why this plan exists at all

The spec's Plan A entry says `msgpackCodec` "lands in `webrun-msgpack` with a type-only
dependency". **It never landed.** Plan A shipped `structuredCodec` and nothing else, and nobody
noticed because every consumer so far has been a `MessagePort`, where structured clone does the
work. The consequence is that **no byte transport can run `multiplexPort` today** — `-ws`,
`-livekit` and `-peerjs` are all blocked, which is why the codec is layer 3's first step rather
than a footnote of it.

## Facts measured before this plan was written

Measured 2026-09-06 against `@ygoe/msgpack` as installed. Do not re-derive; do re-verify anything
you depend on.

| question | answer |
| --- | --- |
| Does a `Uint8Array` payload survive? | **Yes, exactly** — msgpack `bin`, byte-identical, at 0 and 1 MiB |
| Overhead on a 1 MiB body | 20 bytes (1 048 628 encoded) |
| Do `serializeError`'s custom fields survive? | **Yes** — `status`, `code` and `stack` all round-trip |
| Does an offset `subarray` view decode? | **Yes** — no defensive copy needed |
| `deserialize` on garbage / empty / truncated | **Throws** (`Invalid byte code 0xc1`, `…is empty`, `Invalid byte value 'undefined' at index N`) |
| `undefined` object values | **Dropped.** `{a: undefined, b: 1}` → `{b: 1}` |

Two of those shape the design:

**`deserialize` throws, so `read` must catch.** A throw inside a raw port's own message listener
escapes every assertion — Plan A recorded this as a knowingly-uncovered path where "the suite still
exits non-zero" is the honest description. Here it is reachable by any peer sending a malformed
frame, so it must be caught, not tolerated.

**msgpack drops `undefined`; structured clone keeps it.** This is the one place the two codecs are
not interchangeable, and it is exactly the hazard D16 and risk R4 warn about: a difference that is
invisible in development (where the port transport is used) and only appears over the wire. It is
benign for everything layer 2 currently sends — `receiveChunks` tests `error ? … : undefined`, so
missing and `undefined` are both falsy — but it must be **tested and documented**, not left to be
rediscovered.

One wart worth knowing: on a truncated frame `@ygoe/msgpack` prints the offending buffer to the
console before throwing. A hostile peer can therefore make noise in a victim's console. Nothing in
this plan can prevent it; record it, do not try to suppress it.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **G1. `webrun-rpc` must not gain a msgpack dependency.** The codec lives in `webrun-msgpack` and
  imports `PortCodec`/`PortEnvelope` with `import type`, so no runtime import is emitted. Verify
  that by reading the built output, not by assuming.
- **G2. Adapters depend on nothing in this repository (D20).** This plan touches **no** adapter's
  `src/`. Task 4 adds a measurement harness under `packages/webrun-streams-ws/tests/` and changes
  no production file.
- **G3. Layer 1 holds nothing (D3).** Do not modify `multiplex-port.ts`, `virtual-port.ts`,
  `port-types.ts` or `duplex-over-port.ts`. If the codec appears to need a change in any of them,
  stop and report it — that would mean `PortCodec` is the wrong seam, which is a spec-level finding.
- **G4. Nothing is deleted.** `emulateMux`, `connect`/`serve`, `byteChannelFromMessagePort`,
  `uint32.ts` and **both** conformance runs stay. Deletion is Plan C3.
- **G5. No changes to `packages/webrun-streams-conformance/`.** L6's redefinition and the
  `PairTuning` reshape are C3's, because five adapters still run L6 against `emulateMux`.
- **G6. `pnpm --filter <pkg> <script>` exits 0 when the script does not exist**, printing
  `None of the selected packages has a "<script>" script`. Confirm each verification produced real
  tool output. Separately, **`pnpm -r <script>` bails on the first failing package** — use
  `pnpm -r --no-bail` whenever you are enumerating failures rather than gating on them.
- **G7. Never restore a file with `git checkout -- <path>`.** It restores the last *committed*
  state and destroys uncommitted work; this project lost work to it three times, once with an exact
  file path. `cp` to a scratch path, mutate, `cp` back, verify with `diff`.
- **G8. Report the real test count**, as a delta. Baselines measured 2026-09-06:
  `@statewalker/webrun-msgpack` **25 tests / 1 file**; `@statewalker/webrun-rpc` **120 tests /
  19 files**; repo-wide **766 passed / 5 skipped**.
- **G9. Every absence assertion needs a floor.** "Ignored", "no error", "nothing arrived" are all
  satisfied by breaking the machinery outright.
- **G10. No fixed tick counts in tests** — poll a condition with a labelled timeout.
- **G11. Measure, do not predict.** Every mutation step reports what it *actually* killed beside
  what was predicted. In the previous plan five predictions out of twenty-three were wrong. A
  prediction that misses is the finding.

---

## File structure

| file | responsibility |
| --- | --- |
| `packages/webrun-msgpack/tsconfig.tests.json` | **Create.** Typecheck `tests` as well as `src` — today `tsconfig.json` includes only `src`. |
| `packages/webrun-msgpack/package.json` | **Modify.** Add `typecheck:tests`; make `lint` read-only; add the type-only `webrun-rpc` dependency. |
| `packages/webrun-msgpack/src/port-codec.ts` | **Create.** `msgpackCodec` and nothing else. |
| `packages/webrun-msgpack/src/index.ts` | **Modify.** Export it. |
| `packages/webrun-msgpack/tests/port-codec.test.ts` | **Create.** Round-trip, rejection, and never-throw. |
| `packages/webrun-msgpack/tests/codec-equivalence.test.ts` | **Create.** The two codecs against the same envelopes, including where they differ. |
| `packages/webrun-msgpack/tests/conformance-bytes.test.ts` | **Create.** L0–L6 over an in-process byte pipe. |
| `packages/webrun-streams-ws/tests/bridge-cost.bench.ts` | **Create.** The measurement that gates C2. Not a unit test. |
| `packages/webrun-msgpack/README.md` | **Modify.** Document the codec and the two codecs' one difference. |
| `.changeset/msgpack-port-codec.md` | **Create.** `minor` for `@statewalker/webrun-msgpack`. |

`port-codec.ts` is deliberately separate from `msgpack.ts`: the existing file is a *stream* codec
(length-prefixed frames across chunk boundaries) and this one is a *message* codec (one frame per
message, boundaries preserved by the transport). Putting both in one file would invite someone to
reuse the length prefix, which here would be redundant framing on a transport that already frames.

---

### Task 1: Package setup, and `msgpackCodec`

`webrun-msgpack` is about to gain a typed public API whose type-level correctness is the point, and
its tests are currently **not typechecked at all** — `tsconfig.json` includes only `src`. That is
the same defect Plan B1 found in `webrun-rpc`, where fixing it surfaced 20 pre-existing type errors.
Fix the setup first, in the same task, because the test that proves `msgpackCodec` satisfies
`PortCodec` is a type-level test and is worthless untypechecked.

**Files:**
- Create: `packages/webrun-msgpack/tsconfig.tests.json`
- Modify: `packages/webrun-msgpack/package.json`
- Create: `packages/webrun-msgpack/src/port-codec.ts`
- Modify: `packages/webrun-msgpack/src/index.ts`
- Test: `packages/webrun-msgpack/tests/port-codec.test.ts`

**Interfaces:**
- Consumes: `PortCodec`, `PortEnvelope` and `MessageTarget` from `@statewalker/webrun-rpc`, all
  **type-only**; `serialize`/`deserialize` from `@ygoe/msgpack`'s default export.
- Produces: `export const msgpackCodec: PortCodec` from `./port-codec.js`, re-exported by the
  package root. Later tasks and Plan C2 use exactly that name.

- [ ] **Step 1: Fix the package setup**

Create `packages/webrun-msgpack/tsconfig.tests.json`, mirroring `webrun-rpc`'s:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./tsconfig.json",
  "compilerOptions": {
    // The build config roots at `src` to shape `dist`. This one only
    // typechecks, so it widens the root to take `tests` in as well.
    "rootDir": ".",
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["./src", "./tests"]
}
```

In `packages/webrun-msgpack/package.json`, add the script and fix `lint`. It is currently
`biome check --write .`, which **auto-fixes**; a lint that rewrites files cannot gate anything.
Match `webrun-rpc`'s read-only form:

```json
    "typecheck:tests": "tsc -p tsconfig.tests.json",
    "lint": "biome check src tests",
```

and add the type-only dependency to `dependencies` (it must be declared, because the emitted
`.d.ts` refers to `PortCodec`; `import type` keeps it out of the emitted `.js`):

```json
    "@statewalker/webrun-rpc": "workspace:*",
```

- [ ] **Step 2: Run the new typecheck and report what it finds**

Run: `pnpm --filter @statewalker/webrun-msgpack typecheck:tests`
Expected: it now compiles `tests/msgpack.test.ts`, which has never been typechecked. **Report every
error it surfaces.** If there are none, say so; if there are pre-existing ones, fix them in this
step and report the count — `webrun-rpc`'s equivalent moment surfaced 20.

Then `pnpm --filter @statewalker/webrun-msgpack lint` and confirm it now reports rather than writes.
Then `pnpm install` at the repository root so the new workspace dependency resolves.

Commit this separately — it is setup, and a reviewer should be able to accept or reject it alone:

```bash
git add packages/webrun-msgpack/tsconfig.tests.json packages/webrun-msgpack/package.json pnpm-lock.yaml
git commit -m "chore(msgpack): typecheck the tests, and make lint gate instead of rewrite

tsconfig.json included only src, so tests were never typechecked — the same
defect Plan B1 found in webrun-rpc. The codec landing next is a typed public
API, so the test that proves it satisfies PortCodec has to be compiled."
```

- [ ] **Step 3: Write the failing tests**

Create `packages/webrun-msgpack/tests/port-codec.test.ts`:

```ts
import type { MessageTarget, PortEnvelope } from "@statewalker/webrun-rpc";
import { describe, expect, it } from "vitest";
import { msgpackCodec } from "../src/index.js";

/** A one-shot sink that records what was posted, plus the transfer list. */
function recordingPort(): MessageTarget & { sent: unknown[]; transfers: (Transferable[] | undefined)[] } {
  const sent: unknown[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  return {
    sent,
    transfers,
    postMessage(message: unknown, transfer?: Transferable[]) {
      sent.push(message);
      transfers.push(transfer);
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Build the MessageEvent shape `read` is given, without a real port. */
function event(data: unknown): MessageEvent {
  return new MessageEvent("message", { data });
}

/** Post an envelope and read it straight back — one full trip through the codec. */
function roundTrip(envelope: PortEnvelope): PortEnvelope | undefined {
  const port = recordingPort();
  msgpackCodec.post(port, envelope);
  return msgpackCodec.read(event(port.sent[0]));
}

describe("msgpackCodec — round trip", () => {
  it("carries an open envelope with meta", () => {
    expect(roundTrip({ type: "open", id: 0, meta: { kind: "stream" } })).toEqual({
      type: "open",
      id: 0,
      meta: { kind: "stream" },
    });
  });

  it("carries a close envelope with an opaque reason", () => {
    expect(roundTrip({ type: "close", id: 3, reason: "rejected" })).toEqual({
      type: "close",
      id: 3,
      reason: "rejected",
    });
  });

  it("carries a Uint8Array payload byte-for-byte", () => {
    const value = new Uint8Array([0, 1, 127, 128, 255]);
    const out = roundTrip({
      type: "message",
      id: 2,
      payload: { type: "request", channelName: "in", callId: "c1", params: { done: false, value } },
    });
    const back = (out as { payload: { params: { value: Uint8Array } } }).payload.params.value;
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Array.from(back)).toEqual([0, 1, 127, 128, 255]);
  });

  it("carries an empty Uint8Array as an empty Uint8Array", () => {
    const out = roundTrip({
      type: "message",
      id: 4,
      payload: { params: { done: false, value: new Uint8Array(0) } },
    });
    const back = (out as { payload: { params: { value: Uint8Array } } }).payload.params.value;
    expect(back).toBeInstanceOf(Uint8Array);
    expect(back.byteLength).toBe(0);
  });

  it("carries a serialised error's custom fields and stack", () => {
    const out = roundTrip({
      type: "message",
      id: 6,
      payload: {
        type: "response:error",
        channelName: "out",
        callId: "c2",
        error: { message: "boom", stack: "at x", status: 418, code: "TEAPOT" },
      },
    });
    expect((out as { payload: { error: unknown } }).payload.error).toEqual({
      message: "boom",
      stack: "at x",
      status: 418,
      code: "TEAPOT",
    });
  });

  it("posts one message per envelope, and no transfer list", () => {
    // The payload is inside the bytes, so there is nothing left to transfer.
    // An empty transfer list is not the same as none — some implementations
    // reject the former — so the codec must pass none at all.
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: 2, payload: { a: 1 } }, [
      new ArrayBuffer(8) as Transferable,
    ]);
    expect(port.sent.length).toBe(1);
    expect(port.sent[0]).toBeInstanceOf(Uint8Array);
    expect(port.transfers[0]).toBeUndefined();
  });
});

describe("msgpackCodec — what it refuses, without throwing", () => {
  // Each of these is an absence assertion. Their floor is the round-trip
  // block above and the final test in this block: a codec that returned
  // `undefined` for everything would pass all the refusals and fail those.
  const junk: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "not bytes"],
    ["a plain object", { type: "message", id: 1 }],
    ["empty bytes", new Uint8Array(0)],
    ["invalid msgpack", new Uint8Array([0xc1, 0xff, 0x00])],
  ];

  for (const [label, data] of junk) {
    it(`ignores ${label} and does not throw`, () => {
      expect(() => msgpackCodec.read(event(data))).not.toThrow();
      expect(msgpackCodec.read(event(data))).toBeUndefined();
    });
  }

  it("ignores a truncated frame and does not throw", () => {
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: 2, payload: { a: 1 } });
    const whole = port.sent[0] as Uint8Array;
    const cut = whole.subarray(0, whole.byteLength - 3);
    expect(() => msgpackCodec.read(event(cut))).not.toThrow();
    expect(msgpackCodec.read(event(cut))).toBeUndefined();
  });

  it("ignores well-formed msgpack that is not an envelope", () => {
    const port = recordingPort();
    // Valid msgpack, wrong shape — a shared transport's own traffic.
    msgpackCodec.post(port, { hello: "world" } as unknown as PortEnvelope);
    expect(msgpackCodec.read(event(port.sent[0]))).toBeUndefined();
  });

  it("accepts an ArrayBuffer and an offset view, not only a tight Uint8Array", () => {
    // A transport pump may hand over either. Measured: @ygoe/msgpack decodes
    // an offset subarray correctly, so no defensive copy is needed — but the
    // codec must still accept the shapes.
    const port = recordingPort();
    msgpackCodec.post(port, { type: "message", id: 8, payload: { a: 1 } });
    const tight = port.sent[0] as Uint8Array;

    const asBuffer = tight.slice().buffer;
    expect(msgpackCodec.read(event(asBuffer))).toEqual({ type: "message", id: 8, payload: { a: 1 } });

    const padded = new Uint8Array(tight.byteLength + 8);
    padded.set(tight, 4);
    const view = padded.subarray(4, 4 + tight.byteLength);
    expect(msgpackCodec.read(event(view))).toEqual({ type: "message", id: 8, payload: { a: 1 } });
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @statewalker/webrun-msgpack test -- tests/port-codec.test.ts`
Expected: FAIL at import — `msgpackCodec` is not exported. Confirm vitest actually reported a file;
an empty run is G6's trap.

- [ ] **Step 5: Implement the codec**

Create `packages/webrun-msgpack/src/port-codec.ts`:

```ts
import type { PortCodec, PortEnvelope } from "@statewalker/webrun-rpc";
import msgpack from "@ygoe/msgpack";

const { serialize, deserialize } = msgpack;

/**
 * Same shape check as `structuredCodec`'s, applied after decoding. A shared
 * transport carries traffic that is not ours, and layer 1 must not mistake it
 * for an envelope.
 */
function isEnvelope(value: unknown): value is PortEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; id?: unknown };
  if (typeof candidate.id !== "number") return false;
  if (!Number.isInteger(candidate.id) || candidate.id < 0) return false;
  return candidate.type === "open" || candidate.type === "message" || candidate.type === "close";
}

/** Accept whatever byte shape a transport pump hands over. */
function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return undefined;
}

/**
 * For ports whose messages are bytes — a WebSocket, a WebRTC data channel, a
 * LiveKit data packet.
 *
 * One envelope becomes one msgpack frame and one `postMessage`. There is no
 * length prefix, because every transport this codec targets preserves message
 * boundaries; adding one would be redundant framing on a transport that
 * already frames. (`encodeMsgpack`/`decodeMsgpack` in this package *do* carry
 * a length prefix — they are a stream codec for a transport with no
 * boundaries, and are a different thing.)
 *
 * The transfer list is deliberately ignored: after encoding, the payload is
 * inside the bytes, so there is nothing left to hand over.
 *
 * **Not interchangeable with `structuredCodec` in one respect:** msgpack drops
 * object keys whose value is `undefined`, where structured clone preserves
 * them. Nothing layer 2 sends depends on that distinction today, and it must
 * not come to — see spec D16.
 */
export const msgpackCodec: PortCodec = {
  post(port, envelope) {
    port.postMessage(serialize(envelope));
  },

  read(event) {
    const bytes = toBytes(event.data);
    if (!bytes || bytes.byteLength === 0) return undefined;
    let decoded: unknown;
    try {
      decoded = deserialize(bytes);
    } catch {
      // A malformed frame is a peer bug or hostile traffic. Dropping it keeps
      // layer 1's drop-never-queue posture; throwing here would escape into
      // the raw port's own listener, outside any consumer's reach.
      return undefined;
    }
    return isEnvelope(decoded) ? decoded : undefined;
  },
};
```

Add to `packages/webrun-msgpack/src/index.ts`:

```ts
export { msgpackCodec } from "./port-codec.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-msgpack test`
Expected: PASS, +15 tests over the 25-test baseline. Then `typecheck`, `typecheck:tests` and `lint`,
each producing real output.

- [ ] **Step 7: Prove `webrun-rpc` gained no runtime dependency**

The whole reason the codec lives here is G1. Verify it rather than assume it:

```bash
pnpm --filter @statewalker/webrun-msgpack build
grep -n "webrun-rpc" packages/webrun-msgpack/dist/index.js || echo "no runtime import — correct"
grep -rn "webrun-rpc" packages/webrun-msgpack/dist/*.d.ts | head -3
```

Expected: **no** match in `index.js` (the `import type` is erased), and a type-only reference in the
`.d.ts`. Report both results. If `index.js` does import `webrun-rpc`, the `import type` was written
as a value import — fix it.

- [ ] **Step 8: Measure two mutations**

Per G7 — `cp` to a scratch path first, mutate, `cp` back, verify with `diff`.

| mutation | predicted killer |
| --- | --- |
| delete the `try`/`catch` in `read`, calling `deserialize` bare | the invalid-msgpack, empty-bytes and truncated-frame tests |
| make `isEnvelope` return `true` unconditionally | "ignores well-formed msgpack that is not an envelope", and the plain-object case |

Report what each **actually** killed. Run each at least twice.

- [ ] **Step 9: Commit**

```bash
git add packages/webrun-msgpack/src/port-codec.ts packages/webrun-msgpack/src/index.ts \
        packages/webrun-msgpack/tests/port-codec.test.ts
git commit -m "feat(msgpack): msgpackCodec — a PortCodec for transports that carry bytes

One envelope, one msgpack frame, one postMessage. No length prefix: every
transport this targets preserves message boundaries, so framing again would
be redundant. deserialize throws on malformed input, so read catches and
drops — a throw there would escape into the raw port's own listener.

Spec D6. Unblocks -ws, -livekit and -peerjs, none of which could run
multiplexPort at all without a byte codec."
```

---

### Task 2: The two codecs, compared

D16 says layer 2 may send only what msgpack can express. Until now that has been a rule with no
enforcement: every test in the repository runs over `structuredCodec`, where a violation is
invisible. This task makes the rule checkable, and pins the one place the codecs genuinely differ.

**Files:**
- Test: `packages/webrun-msgpack/tests/codec-equivalence.test.ts`

**Interfaces:**
- Consumes: `msgpackCodec` from `../src/index.js` (Task 1); `structuredCodec` and the
  `PortEnvelope` type from `@statewalker/webrun-rpc`.
- Produces: no API. The deliverable is the comparison and the documented difference.

- [ ] **Step 1: Write the tests**

Create `packages/webrun-msgpack/tests/codec-equivalence.test.ts`:

```ts
import type { MessageTarget, PortCodec, PortEnvelope } from "@statewalker/webrun-rpc";
import { structuredCodec } from "@statewalker/webrun-rpc";
import { describe, expect, it } from "vitest";
import { msgpackCodec } from "../src/index.js";

function through(codec: PortCodec, envelope: PortEnvelope): PortEnvelope | undefined {
  let sent: unknown;
  const port: MessageTarget = {
    postMessage(message: unknown) {
      sent = message;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  codec.post(port, envelope);
  return codec.read(new MessageEvent("message", { data: sent }));
}

/**
 * Everything layer 2 actually puts on the wire, as `duplexOverPort`,
 * `callPort`/`listenPort` and `multiplexPort` construct it. If a new envelope
 * shape is added later, it belongs in this list.
 */
const LAYER_2_TRAFFIC: Array<[string, PortEnvelope]> = [
  ["open, no meta", { type: "open", id: 0 }],
  ["open, stream meta", { type: "open", id: 2, meta: { kind: "stream" } }],
  ["open, control meta", { type: "open", id: 4, meta: { kind: "control" } }],
  ["close, no reason", { type: "close", id: 0 }],
  ["close, string reason", { type: "close", id: 2, reason: "max-ports" }],
  [
    "chunk request",
    {
      type: "message",
      id: 2,
      payload: {
        type: "request",
        channelName: "in",
        callId: "call-1-2",
        params: { done: false, value: new Uint8Array([1, 2, 3]) },
      },
    },
  ],
  [
    "final chunk",
    {
      type: "message",
      id: 2,
      payload: {
        type: "request",
        channelName: "out",
        callId: "call-1-3",
        params: { done: true },
      },
    },
  ],
  [
    "confirmation",
    {
      type: "message",
      id: 2,
      payload: { type: "response:result", channelName: "in", callId: "call-1-2" },
    },
  ],
  [
    "error response",
    {
      type: "message",
      id: 2,
      payload: {
        type: "response:error",
        channelName: "out",
        callId: "call-1-4",
        error: { message: "boom", stack: "at x", status: 418, code: "TEAPOT" },
      },
    },
  ],
  [
    "stream abort notice",
    { type: "message", id: 2, payload: { type: "webrun-rpc:stream-abort" } },
  ],
];

describe("the two codecs agree on everything layer 2 sends (spec D16)", () => {
  for (const [label, envelope] of LAYER_2_TRAFFIC) {
    it(`${label} survives both codecs identically`, () => {
      const viaStructured = through(structuredCodec, envelope);
      const viaMsgpack = through(msgpackCodec, envelope);
      expect(viaStructured).toBeDefined();
      expect(viaMsgpack).toBeDefined();
      expect(viaMsgpack).toEqual(viaStructured);
    });
  }
});

describe("where the two codecs differ, and it is on purpose", () => {
  it("msgpack drops an explicitly-undefined key; structured clone keeps it", () => {
    // This is the one asymmetry, and it is the shape spec risk R4 warns about:
    // invisible in development over a MessagePort, visible only over bytes.
    // It is benign today because every consumer tests `error ? … : undefined`,
    // where missing and undefined are both falsy. It must stay benign.
    const envelope = {
      type: "message",
      id: 2,
      payload: { done: true, value: undefined, error: undefined },
    } as PortEnvelope;

    const viaStructured = through(structuredCodec, envelope) as { payload: object };
    const viaMsgpack = through(msgpackCodec, envelope) as { payload: object };

    expect("error" in viaStructured.payload).toBe(true);
    expect("error" in viaMsgpack.payload).toBe(false);
    // The floor: what actually matters — reading the key — agrees.
    expect((viaStructured.payload as { error?: unknown }).error).toBeUndefined();
    expect((viaMsgpack.payload as { error?: unknown }).error).toBeUndefined();
  });

  it("both refuse traffic that is not theirs", () => {
    const notOurs = new MessageEvent("message", { data: { hello: "world" } });
    expect(structuredCodec.read(notOurs)).toBeUndefined();
    expect(msgpackCodec.read(notOurs)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm --filter @statewalker/webrun-msgpack test -- tests/codec-equivalence.test.ts`
Expected: PASS, 12 tests. **If any envelope in `LAYER_2_TRAFFIC` fails the equality check, stop and
report it** — that is a D16 violation in shipped code, and it is the single most valuable thing this
task can find. Do not adjust the expectation to make it pass.

- [ ] **Step 3: Prove the comparison is load-bearing**

Per G7. Mutate `msgpackCodec.read` to return `structuredCodec.read(event)` instead of decoding —
i.e. make the two codecs trivially identical. Predicted: the round-trip tests in
`port-codec.test.ts` fail (bytes never decode) while this file passes, showing that equivalence
alone is not enough and the two files together are what pin the behaviour. Report what actually
happened.

- [ ] **Step 4: Commit**

```bash
git add packages/webrun-msgpack/tests/codec-equivalence.test.ts
git commit -m "test(msgpack): pin the two codecs against each other on real layer 2 traffic

D16 says layer 2 may send only what msgpack can express, and until now that
was a rule with no enforcement — every test in the repository runs over
structuredCodec, where a violation is invisible.

The one asymmetry is msgpack dropping explicitly-undefined keys. Benign
today, because every consumer tests `error ? … : undefined`. Pinned so it
stays that way."
```

---

### Task 3: L0–L6 over an in-process byte pipe

The headline. If `multiplexPort` + `duplexOverPort` pass the unmodified conformance suite over a
transport that carries **bytes**, then C2's adapters have nothing left to prove about the stack —
only about their own transports.

**Files:**
- Test: `packages/webrun-msgpack/tests/conformance-bytes.test.ts`
- Modify: `packages/webrun-msgpack/package.json` (add the conformance dev dependency)

**Interfaces:**
- Consumes: `msgpackCodec` (Task 1); `multiplexPort`, `duplexOverPort`, `serveDuplexOverPort`,
  `PortMux`, `MessageTarget` from `@statewalker/webrun-rpc`; `describeDuplexAdapter` and `MakePair`
  from `@statewalker/webrun-streams-conformance`; `Duplex` from `@statewalker/webrun-streams`.
- Produces: no API. The deliverable is a passing third conformance run.

- [ ] **Step 1: Add the dev dependencies**

In `packages/webrun-msgpack/package.json`, add to `devDependencies`:

```json
    "@statewalker/webrun-streams": "workspace:*",
    "@statewalker/webrun-streams-conformance": "workspace:*",
```

Then `pnpm install` at the repository root.

- [ ] **Step 2: Write the pair and run the suite**

Create `packages/webrun-msgpack/tests/conformance-bytes.test.ts`:

```ts
import type { MessageListener, MessageTarget, PortMux } from "@statewalker/webrun-rpc";
import { duplexOverPort, multiplexPort, serveDuplexOverPort } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { msgpackCodec } from "../src/index.js";

/**
 * Two `MessageTarget`s that exchange **bytes**, delivered on a later
 * macrotask and in order — the same contract a WebSocket, a data channel or a
 * LiveKit packet stream offers, with none of the transport.
 *
 * This is deliberately not a `MessageChannel`: a `MessageChannel` carries
 * structured values, which is the case `structuredCodec` already covers. What
 * is unproven is the byte path.
 */
function bytePipePair(): { a: MessageTarget; b: MessageTarget; close(): void } {
  const listeners: [Set<MessageListener>, Set<MessageListener>] = [new Set(), new Set()];
  let open = true;

  const make = (self: 0 | 1): MessageTarget => {
    const peer = (1 - self) as 0 | 1;
    return {
      postMessage(message: unknown) {
        if (!open) return;
        // A byte transport carries bytes and nothing else. Anything else here
        // is the codec breaking its contract, and must not be papered over.
        if (!(message instanceof Uint8Array)) {
          throw new TypeError(
            `bytePipePair: expected Uint8Array on the wire, got ${Object.prototype.toString.call(message)}`,
          );
        }
        // Copy, because a real transport does not share the sender's buffer.
        const copy = message.slice();
        setTimeout(() => {
          if (!open) return;
          const event = new MessageEvent("message", { data: copy });
          for (const listener of [...listeners[peer]]) {
            try {
              void listener(event);
            } catch {
              /* one consumer's fault is not the pipe's */
            }
          }
        }, 0);
      },
      addEventListener(_type: "message", listener: MessageListener) {
        listeners[self].add(listener);
      },
      removeEventListener(_type: "message", listener: MessageListener) {
        listeners[self].delete(listener);
      },
    };
  };

  return {
    a: make(0),
    b: make(1),
    close() {
      open = false;
      listeners[0].clear();
      listeners[1].clear();
    },
  };
}

/**
 * The C1 stack: a byte pipe, `multiplexPort` with `msgpackCodec` on each end,
 * a virtual port per call, `duplexOverPort` on that port.
 *
 * `PairTuning` is ignored, exactly as the `webrun-rpc` new-stack pair ignores
 * it: this design has no credit window to shrink, so **L6 here is an integrity
 * check only** — its green says the body round-trips and says nothing about
 * flow control. L6's redefinition is spec D17, sequenced into Plan C3 because
 * five adapters still run it against `emulateMux`, where the window is real.
 * This stack's flow-control coverage lives in `webrun-rpc`'s own
 * `duplex-over-port-timeout` and `duplex-over-port-hostile` suites.
 */
const makeBytePair: MakePair = async () => {
  const pipe = bytePipePair();
  let clientMux: PortMux | undefined;
  let serverMux: PortMux | undefined;

  return {
    async connect() {
      clientMux ??= multiplexPort(pipe.a, { codec: msgpackCodec, side: "initiator" });
      const mux = clientMux;
      const call: Duplex = (input) =>
        (async function* () {
          const streamPort = await mux.openPort({ kind: "stream" });
          yield* duplexOverPort(streamPort, { maxMessageSize: mux.maxMessageSize })(input);
        })();
      return {
        call,
        async close() {
          /* the pair's own close tears the muxes down */
        },
      };
    },

    async serve(handler: Duplex) {
      const mux = multiplexPort(pipe.b, {
        codec: msgpackCodec,
        side: "responder",
        onPort: (port) => {
          serveDuplexOverPort(port, handler, { maxMessageSize: mux.maxMessageSize });
        },
      });
      serverMux = mux;
      let torn = false;
      return async () => {
        if (torn) return;
        torn = true;
        if (serverMux === mux) serverMux = undefined;
        await mux.close();
      };
    },

    async close() {
      await clientMux?.close().catch(() => {});
      await serverMux?.close().catch(() => {});
      clientMux = undefined;
      serverMux = undefined;
      pipe.close();
    },
  };
};

describeDuplexAdapter("msgpackCodec over an in-process byte pipe", makeBytePair);
```

Run: `pnpm --filter @statewalker/webrun-msgpack test -- tests/conformance-bytes.test.ts`
Expected: 11 tests.

- [ ] **Step 3: Diagnose whatever failed, in the codec — never in the pair**

This is the task's real work, and the place to be strict with yourself. **A pair rigged to make a
level pass is worse than a red one.** In particular:

- Do **not** use `opts.skipHugeBody` for L0's 10 MiB case. It exists for rate-limited real
  transports. Here it would hide the exact failure this project has already been burned by: a large
  body arriving as **zero bytes with no error on either side**.
- Do **not** relax the `Uint8Array` guard in `bytePipePair.postMessage`. If the codec puts a
  non-byte value on a byte transport, that is the bug the guard exists to catch.
- Do **not** modify `packages/webrun-streams-conformance/` (G5) or anything in `webrun-rpc` (G3).

Two failures are plausible and their causes are named:

*L0's 10 MiB body is slow or fails.* At ~20 bytes of msgpack overhead the encoding is not the
problem; a `serialize` of a 10 MiB `Uint8Array` allocates a second 10 MiB buffer, and the pipe's
`slice()` a third. If it is merely slow, say so with a number rather than skipping it. If it fails,
find out where — that is a genuine finding about the codec's suitability for large bodies, and C2
needs it.

*L1's 10 concurrent calls interleave.* Each call opens its own virtual port, so they share no
state; if they interfere, the fault is in the codec's `read` returning a shared or mutated buffer.

If a level fails for a reason neither paragraph covers, describe it fully in your report **before**
fixing it. That is the most valuable thing this plan can produce.

- [ ] **Step 4: Prove the run is not decorative**

An all-green first run proves nothing on its own. Kill it deliberately and report the result:
mutate `msgpackCodec.read` to return `undefined` unconditionally, and confirm the suite goes red.
Then a subtler one: make `post` serialize `{ ...envelope, id: envelope.id + 1 }`, and report which
levels die. `cp` to a scratch path and back, verified with `diff`.

- [ ] **Step 5: Run everything**

Run: `pnpm --filter @statewalker/webrun-msgpack test`, then `typecheck`, `typecheck:tests`, `lint`.
Then the whole repository: `pnpm -r test`, and `pnpm -r --no-bail typecheck`.

Report repo-wide totals as a delta against **766 passed / 5 skipped**. For typecheck, note that
`--no-bail` is required to see all failures: five apps fail pre-existing on missing `dist/`
directories (`site-builder-demo`, `site-builder-jspm-demo`, `livekit-demo`, `p2p-demo`,
`site-builder-tsx-spike`). Confirm your change adds none.

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-msgpack/tests/conformance-bytes.test.ts packages/webrun-msgpack/package.json \
        pnpm-lock.yaml
git commit -m "test(msgpack): the new stack passes L0-L6 over a byte transport

multiplexPort + duplexOverPort over msgpackCodec, on an in-process pipe that
carries bytes and refuses anything else. The suite is unmodified — spec D9's
claim again, now on the path that was blocked.

L6 is an integrity check for this pair and says nothing about flow control;
stated where the pair is declared. Its redefinition is D17, in Plan C3."
```

---

### Task 4: What bridging a byte transport to a real `MessagePort` costs

The spec says a single-pipe adapter "creates a `MessageChannel` and pumps between the transport and
one end, so every message crosses a structured-clone hop and a macrotask that a plain
`MessageTarget` object would not incur", and asks for this to be measured on `-ws` **before**
committing the other two adapters. Plan B did not do it. It gates C2, and it is cheap now.

This task changes **no production file**. Its deliverable is a number and a recommendation.

**Files:**
- Create: `packages/webrun-streams-ws/tests/bridge-cost.bench.ts`

**Interfaces:**
- Consumes: `byteChannelFromWebSocket` from `../src/byte-channel.js`; `WebSocketLike` from
  `../src/websocket-like.js`; `ws` (already a dev dependency of that package).
- Produces: no API. A recorded measurement, reported in the task report and carried into the
  findings document.

- [ ] **Step 1: Write the harness**

Create `packages/webrun-streams-ws/tests/bridge-cost.bench.ts`. It is a vitest test file so it runs
in CI, but its assertions are deliberately loose — **it reports, it does not gate**. A benchmark
asserting a threshold on shared CI hardware is a flake generator.

```ts
import { describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import type { WebSocketLike } from "../src/websocket-like.js";

/** Echo server: every inbound frame goes straight back. */
async function echoServer(): Promise<{ url: string; close(): Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => {
    ws.binaryType = "nodebuffer";
    ws.on("message", (data: Buffer) => ws.send(data));
  });
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}

async function openSocket(url: string): Promise<WebSocketLike> {
  const ws = new NodeWebSocket(url) as unknown as WebSocketLike;
  (ws as unknown as { binaryType: string }).binaryType = "nodebuffer";
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error before open")));
  });
  return ws;
}

/** Round-trip `count` frames of `size` bytes, awaiting each before sending the next. */
async function timeRoundTrips(
  send: (bytes: Uint8Array) => void,
  onMessage: (cb: (bytes: Uint8Array) => void) => void,
  count: number,
  size: number,
): Promise<number> {
  const payload = new Uint8Array(size).fill(7);
  let resolveOne: (() => void) | null = null;
  onMessage(() => {
    const r = resolveOne;
    resolveOne = null;
    r?.();
  });
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const done = new Promise<void>((r) => {
      resolveOne = r;
    });
    send(payload);
    await done;
  }
  return performance.now() - started;
}

describe("cost of bridging a WebSocket to a real MessagePort", () => {
  it("reports direct vs bridged round-trip cost at three sizes", async () => {
    const server = await echoServer();
    const results: Array<{ size: number; direct: number; bridged: number; ratio: number }> = [];
    try {
      for (const size of [64, 4096, 64 * 1024]) {
        const count = size > 8192 ? 200 : 1000;

        // (a) Direct: the transport's own frames, no MessagePort anywhere.
        const wsDirect = await openSocket(server.url);
        const direct = await timeRoundTrips(
          (bytes) => (wsDirect as unknown as { send(d: Uint8Array): void }).send(bytes),
          (cb) =>
            wsDirect.addEventListener("message", (ev) => {
              const d = (ev as MessageEvent).data as ArrayBufferView | ArrayBuffer;
              cb(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer));
            }),
          count,
          size,
        );
        (wsDirect as unknown as { close(): void }).close();

        // (b) Bridged: WebSocket <-> pump <-> MessageChannel, the shape a port
        // factory must expose, and the caller talks only to `port`.
        const wsBridged = await openSocket(server.url);
        const channel = new MessageChannel();
        channel.port1.start();
        channel.port2.start();
        // pump: transport -> port2 -> (caller holds port1)
        wsBridged.addEventListener("message", (ev) => {
          const d = (ev as MessageEvent).data as ArrayBufferView | ArrayBuffer;
          const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength);
          channel.port2.postMessage(bytes.slice());
        });
        // pump: port2 <- port1 -> transport
        channel.port2.addEventListener("message", (ev) => {
          (wsBridged as unknown as { send(d: Uint8Array): void }).send((ev as MessageEvent).data as Uint8Array);
        });
        const bridged = await timeRoundTrips(
          (bytes) => channel.port1.postMessage(bytes),
          (cb) => channel.port1.addEventListener("message", (ev) => cb((ev as MessageEvent).data as Uint8Array)),
          count,
          size,
        );
        channel.port1.close();
        channel.port2.close();
        (wsBridged as unknown as { close(): void }).close();

        results.push({ size, direct, bridged, ratio: bridged / direct });
      }
    } finally {
      await server.close();
    }

    for (const r of results) {
      console.log(
        `size=${String(r.size).padStart(6)}B  direct=${r.direct.toFixed(1)}ms  bridged=${r.bridged.toFixed(1)}ms  ratio=${r.ratio.toFixed(2)}x`,
      );
    }

    // Deliberately loose. This records a number; it does not gate a threshold,
    // because a timing threshold on shared CI hardware is a flake generator.
    // The floor is that both paths actually completed every round trip.
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.direct).toBeGreaterThan(0);
      expect(r.bridged).toBeGreaterThan(0);
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run it and record the numbers**

Run: `pnpm --filter @statewalker/webrun-streams-ws test -- tests/bridge-cost.bench.ts`
Record the printed table verbatim in your report, and run it **three times** — a single sample of a
timing measurement is not a measurement.

- [ ] **Step 3: Draw the conclusion C2 needs**

Write, in your report, an explicit recommendation with the numbers behind it:

- If the bridged path costs roughly what the direct path costs, C2 proceeds as the spec designs it:
  adapters hand back a real `MessagePort`, which is what lets a transport-backed port be
  transferred into a worker or iframe.
- If it is materially more expensive, say by how much and at which sizes, and state the alternative
  plainly: an adapter can hand back a plain `MessageTarget` object instead, which costs nothing but
  **cannot be transferred** — and the spec's stated reason for wanting a real `MessagePort` is
  exactly that transferability.

**Do not decide it yourself.** Report the number and both options; the choice belongs to the human
partner and shapes all three adapters in C2.

- [ ] **Step 4: Commit**

```bash
git add packages/webrun-streams-ws/tests/bridge-cost.bench.ts
git commit -m "test(ws): measure what bridging a WebSocket to a real MessagePort costs

The spec asked for this before committing three adapters to the shape and
Plan B did not do it. Reports direct vs bridged round-trip time at 64 B,
4 KiB and 64 KiB; asserts only that both paths completed, because a timing
threshold on shared CI hardware is a flake generator."
```

---

### Task 5: Documentation and the changeset

**Files:**
- Modify: `packages/webrun-msgpack/README.md`
- Create: `.changeset/msgpack-port-codec.md`
- Create: `docs/superpowers/2026-09-06-port-mux-layer-3a-findings.md`

**Interfaces:**
- Consumes: the finished API from Tasks 1–4.
- Produces: no code.

- [ ] **Step 1: Update the README**

Read `packages/webrun-msgpack/README.md` first. Its description today is "Length-prefixed
MessagePack frame codec for async iterables" — the package now does two distinct things and the
README must say so. Add:

1. **A section for `msgpackCodec`**, with a runnable example: a byte pipe (or a `MessageChannel`
   carrying `Uint8Array`s), `multiplexPort` with the codec on each end, one `openPort`, one
   `duplexOverPort` round trip, printing the echoed body.
2. **The distinction between the two codecs in this package** — `encodeMsgpack`/`decodeMsgpack` are
   a *stream* codec with a 4-byte length prefix, for a transport with no message boundaries;
   `msgpackCodec` is a *message* codec with no prefix, for a transport that frames. Someone will
   otherwise reach for the wrong one.
3. **The one place `msgpackCodec` and `structuredCodec` differ** — msgpack drops
   explicitly-`undefined` object keys. State that layer 2 must not depend on the difference (D16).
4. **That the transfer list is ignored**, and why.
5. **The `@ygoe/msgpack` console-logging wart** on truncated input, so nobody debugs it twice.

Also update the package's `description` field in `package.json` to cover both codecs.

- [ ] **Step 2: Verify the README example from the committed file**

```bash
pnpm --filter @statewalker/webrun-msgpack build
git show HEAD:packages/webrun-msgpack/README.md > /tmp/msgpack-readme.md
```

Extract the fenced example from `/tmp/msgpack-readme.md` — **not** from your draft — into a scratch
`.mjs`, point its imports at the built `dist`, and run it with `node`. It must print its output and
exit 0. An example that exits 0 printing nothing is a failure: Plan A shipped exactly that, and its
check passed because it ran a padded copy containing a sleep the README never had.

- [ ] **Step 3: Write the changeset**

Create `.changeset/msgpack-port-codec.md`:

```markdown
---
"@statewalker/webrun-msgpack": minor
---

Adds `msgpackCodec`, a `PortCodec` for transports that carry bytes.

`@statewalker/webrun-rpc`'s `multiplexPort` needs a codec to put its envelopes
on the wire. `structuredCodec` passes them through unencoded, which works only
where messages are structured values — a `MessagePort`, a worker, an iframe.
`msgpackCodec` is the byte-transport sibling: one envelope becomes one msgpack
frame and one `postMessage`. There is no length prefix, because every transport
it targets preserves message boundaries; this package's existing
`encodeMsgpack`/`decodeMsgpack` remain the length-prefixed *stream* codec for
transports that do not.

Malformed input is dropped rather than thrown, so a peer cannot take down the
multiplexer with a bad frame. The transfer list is ignored: after encoding, the
payload is inside the bytes.

The dependency on `@statewalker/webrun-rpc` is type-only — it supplies the
`PortCodec` interface and no runtime code, so `webrun-rpc` gains no msgpack
dependency in either direction.

One asymmetry with `structuredCodec`, documented in the README: msgpack drops
object keys whose value is explicitly `undefined`, where structured clone keeps
them. Nothing the RPC layer sends depends on the difference.
```

Then run `npx changeset status` and confirm exit 0. A previous plan's whole-branch review found a
changeset naming a package that no longer existed, which made the repo unable to cut a release, and
no task's diff contained that file.

- [ ] **Step 4: Write the findings document**

Create `docs/superpowers/2026-09-06-port-mux-layer-3a-findings.md`, in the shape of its three
predecessors — read them first. It must contain:

- the commit range, per-package test counts and the repo-wide total;
- **the measured mutation table** — every mutation this plan asked for, what it *actually* killed
  beside what was predicted, and every discrepancy named as one;
- **the bridge-cost measurement from Task 4**, with the three-run numbers and the recommendation,
  because that is what C2 is gated on;
- **the result of typechecking `webrun-msgpack`'s tests for the first time** (Task 1 Step 2) —
  however many errors it surfaced, including zero;
- any place this plan was wrong, with what corrected it;
- a **"For Plan C2"** section listing at minimum: the bridge-cost recommendation and its
  consequence for whether adapters return a real `MessagePort` or a plain `MessageTarget`;
  that `-peerjs`'s message ceiling is **still unmeasured** and must be measured before that adapter
  is migrated (the identical mistake on LiveKit delivered a 1 MiB body as zero bytes with no error
  on either side); that `-webrtc` reports 16 KiB and `-livekit` 12 KiB; and that
  `webrun-streams-signaling` consumes `ByteChannel` as a public type across eight files, which C3
  must decide about rather than discover.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-msgpack/README.md packages/webrun-msgpack/package.json \
        .changeset/msgpack-port-codec.md \
        docs/superpowers/2026-09-06-port-mux-layer-3a-findings.md
git commit -m "docs(msgpack): document both codecs and what separates them

The package now holds a stream codec and a message codec, and reaching for
the wrong one is easy. Also records the bridge-cost measurement C2 is gated
on, and the one place msgpackCodec and structuredCodec disagree."
```

---

## Self-review

**Spec coverage.**

| requirement | task |
| --- | --- |
| D6 — the codec is pluggable, native where possible; bytes encode with msgpack | 1 |
| D16 — layer 2's payload contract is the msgpack-expressible subset | 2 (makes it enforceable for the first time) |
| D9 — `Duplex` is layer 2's output, so the conformance suite covers the new stack unchanged | 3 |
| Spec "Cost of bridging to a real `MessagePort`" — measure on `-ws` before committing the other two | 4 |
| Sequencing C1 — codec proven over an in-process byte pipe, no adapter touched | 3 |

**Deliberately not covered, each with its reason recorded in the spec:** adapters (C2), the
deletion, L6's redefinition, `PairTuning`, D14's control port and `ByteChannel`'s fate (all C3).

**A gap stated rather than hidden:** this plan proves the codec against an in-process pipe, not
against a real transport. That is the point of the split — C2 is where real transports arrive — but
it means C1's green does **not** establish that any particular transport's framing, size limits or
error semantics suit the codec. `-peerjs`'s ceiling in particular is still unmeasured.

**Type consistency.** `msgpackCodec` is spelled identically in every task. `PortCodec`,
`PortEnvelope`, `MessageTarget`, `MessageListener` and `PortMux` all come from
`@statewalker/webrun-rpc` and are all type-only except `multiplexPort`, `duplexOverPort`,
`serveDuplexOverPort` and `structuredCodec`, which are values. `bytePipePair` is defined once, in
Task 3, and referenced nowhere else.
