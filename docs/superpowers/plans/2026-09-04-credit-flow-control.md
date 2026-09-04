# Credit-Based Flow Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `emulateMux`'s stop-and-wait flow control with receiver-advertised credit, so a single stream is no longer round-trip-bound, and move `MessageTarget` down into `webrun-streams`.

**Architecture:** A pure credit ledger (sender side) and grantor (receiver side) live in `webrun-streams/src/flow-control.ts` with no I/O. `emulateMux` wires them to the wire format: `OPEN` and `ACK` each gain a uint32 payload carrying credit. The sender spends credit and stalls at zero instead of awaiting an ACK per frame; the receiver grants credit as its consumer drains. `maxStreamBuffer` stops bounding honest peers and reverts to being a defence against peers that ignore the protocol.

**Tech Stack:** TypeScript, vitest, rolldown, biome. Node + browser, ESM only.

**Spec:** `docs/superpowers/specs/2026-09-04-webrun-rpc-design.md` (this plan implements Decision 8 and Sequencing steps 1–2 — "Plan 1")

## Global Constraints

- **`webrun-streams` has zero runtime dependencies.** It must still have zero when this lands. No new imports from other packages.
- **Red/green TDD, observed.** Every behavioural step writes a failing test first and *runs it to watch it fail*. A test that has never been red proves nothing.
- **The existing L0–L5 conformance suite stays green at every commit.** It is the regression net for six adapters.
- ESM only (`"type": "module"`), TypeScript strict, `moduleResolution: "Bundler"`.
- biome formatting: 2-space indent, line width 100, double quotes, semicolons always, trailing commas all. Run `pnpm lint` before each commit.
- Tests: vitest, files under `tests/`, named `*.test.ts`, run with `pnpm --filter @statewalker/webrun-streams test`.
- Frame format is `[varint streamId][1-byte type][payload]`. `sendFrame(id, type, payload?)` already supports payloads; do not change the header.
- **Wire-format change is expected and permitted.** Old and new peers will not interoperate. Spec Finding 3 establishes there are no external consumers.

## Design note: how credit bootstraps

A stream is bidirectional, so *each* side must advertise the capacity of *its own* receive buffer to the peer.

- The caller's `OPEN` payload carries the caller's `maxStreamBuffer` — that is the credit the responder may spend sending back.
- On receiving `OPEN`, the responder immediately replies `ACK` carrying *its* `maxStreamBuffer` — the credit the caller may spend.

If both sides started at zero credit, the caller could not send a byte until one round trip had completed. To avoid that, both sides start with a protocol constant `INITIAL_CREDIT` (one MTU) that is safe to assume before hearing the peer, and raise to the advertised value when it arrives.

That assumption is only safe if every peer's `maxStreamBuffer` is at least one `mtu`, so Task 3 adds that as a **local** invariant, checked at construction. Note this is a genuine local invariant — it constrains one peer's own two settings against each other — unlike the cross-peer check the spec rejected in Decision 8.

## Repository, package and documentation rules

These apply to every task, and to the plans that follow this one.

**Documentation moves with the code.** A package's README documents its export
surface; several of them enumerate it in tables. Any task that adds, removes,
moves or renames a public export updates the affected README **in the same
commit**, never as a follow-up. Stale export tables are worse than absent ones,
because they read as authoritative. The READMEs this plan touches are called
out in the tasks that touch them.

**This plan creates no package and renames no repository**, so `repos.json` and
the umbrella need no change here. The rules below exist because the plans that
follow — `webrun-rpc` (a new package) and the `webrun-transform` → `webrun-forge`
rename — do trigger them, and getting them wrong is expensive to unwind.

**Renaming a repository uses the `gh` CLI.** Do not rename through the web UI,
and do not create-and-push a new repository: `gh repo rename` preserves issues,
pull requests, stars and — critically — GitHub's redirect from the old URL, so
existing clones and any unmigrated `repos.json` keep working.

```bash
gh repo rename <new-name> --repo statewalker/<old-name>
```

`gh` 2.45.0 is available in this environment. After the rename, update in the
same change:

- `repos.json` in the umbrella — the registry of clone URLs.
- `docs/multirepo/MODEL.md` — names every repository and its status.
- The renamed repo's own root `package.json` `name` field (the `-monorepo`
  suffix) and its `repository.url`.
- Any cross-repo README links pointing at the old GitHub URL.

Note that **published npm package names do not contain the repository name**
(`@statewalker/webrun-modules` lives in `webrun-transform`), so a repo rename is
not an npm-visible change and needs no changeset.

**Creating a package** requires, in the same change: the package directory
under `packages/` (already covered by the workspace glob `packages/*`, so
`pnpm-workspace.yaml` needs no edit), a README following the house structure
(what it is, why it exists, install, getting started, API, dependencies,
licence), a `tsconfig.json` extending `../../tsconfig.base.json`, a
`rolldown.config.js` using `externalsFrom(import.meta.url)`, an entry in
`tsconfig.base.json`'s `paths` map, a row in the root `README.md` package
tables, and a changeset.

**The assembly under `worktrees/` is generated and gitignored.** Nothing there
is committed to the umbrella; only `repos.json` and the durable documents are.

## Deviation from the spec

The spec's Verification section asks for conformance "at a small advertised
credit (one frame's worth, reproducing today's lock-step behaviour) and at the
default". **This plan covers only the default in conformance**, for a concrete
reason: every adapter hardcodes its mux construction —
`emulateMux(channel, { side })` in `webrun-streams-port/src/connect-serve.ts`
and `webrun-streams-ws/src/connect.ts`, and likewise in the other four — and
none of their param types (`PortParams`, `ConnectWsParams`, …) accepts `mtu` or
`maxStreamBuffer`. Varying credit from the conformance suite would mean
widening the public parameter type of all six adapters, which is a larger and
separately reviewable change.

Low-credit behaviour is instead covered where credit *is* configurable, in
`webrun-streams`' own tests: Task 4 pins the bound at 4 frames' worth, Task 5
stalls a sender at a 4 KiB window and proves it resumes, and Task 6 runs a
1 KiB-mtu / 4 KiB-buffer receiver against an 8 MiB-buffer sender. Between them
the low-credit paths are exercised directly against `emulateMux`.

If you would rather have it in conformance, the follow-up is to add an optional
`mux?: EmulateMuxOptions` to each adapter's params and thread it through — a
clean, mechanical change, but one that touches six public APIs.

## File Structure

**Create**
- `packages/webrun-streams/src/flow-control.ts` — pure credit ledger + grantor. No I/O, no framing, no transport types.
- `packages/webrun-streams/tests/flow-control.test.ts` — unit tests for the above.
- `packages/webrun-streams/src/message-target.ts` — the four message-passing interfaces, moved from `webrun-http-browser`.

**Modify**
- `packages/webrun-streams/src/emulate-mux.ts` — uint32 payload helpers, credit on `OPEN`/`ACK`, `pumpOutbound` spends credit, inbound grants it.
- `packages/webrun-streams/src/index.ts` — export `flow-control.js` and `message-target.js`.
- `packages/webrun-streams/tests/emulate-mux-backpressure.test.ts` — the test pinning one-frame-in-flight is rewritten to pin the credit bound.
- `packages/webrun-http-browser/src/core/message-target.ts` — becomes a re-export from `webrun-streams` (5 files import it; re-exporting avoids touching them all).
- `packages/webrun-streams-conformance/src/describe-duplex-adapter.ts` — an L6 level covering flow control against a slow consumer.

---

### Task 1: Credit ledger and grantor (pure, no I/O)

**Files:**
- Create: `packages/webrun-streams/src/flow-control.ts`
- Test: `packages/webrun-streams/tests/flow-control.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `newCreditLedger(initial: number): CreditLedger` where
    `CreditLedger = { readonly available: number; spend(bytes: number): Promise<void>; grant(bytes: number): void; fail(err: Error): void }`
  - `newCreditGrantor(window: number, threshold?: number): CreditGrantor` where
    `CreditGrantor = { consumed(bytes: number): number }`
  - `INITIAL_CREDIT: number` (65536)

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-streams/tests/flow-control.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newCreditGrantor, newCreditLedger } from "../src/flow-control.js";

describe("newCreditLedger", () => {
  it("resolves a spend that fits inside available credit", async () => {
    const ledger = newCreditLedger(100);
    await ledger.spend(40);
    expect(ledger.available).toBe(60);
  });

  it("blocks a spend past available credit until a grant arrives", async () => {
    const ledger = newCreditLedger(50);
    let resolved = false;
    const pending = ledger.spend(80).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    ledger.grant(30);
    await pending;
    expect(resolved).toBe(true);
    expect(ledger.available).toBe(0);
  });

  it("releases waiters in order, and only when each is fully covered", async () => {
    const ledger = newCreditLedger(0);
    const order: number[] = [];
    const first = ledger.spend(10).then(() => order.push(1));
    const second = ledger.spend(10).then(() => order.push(2));

    ledger.grant(10);
    await first;
    expect(order).toEqual([1]);

    ledger.grant(10);
    await second;
    expect(order).toEqual([1, 2]);
  });

  it("rejects pending spends when failed", async () => {
    const ledger = newCreditLedger(0);
    const pending = ledger.spend(10);
    ledger.fail(new Error("transport closed"));
    await expect(pending).rejects.toThrow("transport closed");
  });

  it("rejects later spends once failed", async () => {
    const ledger = newCreditLedger(1000);
    ledger.fail(new Error("gone"));
    await expect(ledger.spend(1)).rejects.toThrow("gone");
  });
});

describe("newCreditGrantor", () => {
  it("accumulates silently below the threshold", () => {
    const grantor = newCreditGrantor(100);
    expect(grantor.consumed(20)).toBe(0);
    expect(grantor.consumed(20)).toBe(0);
  });

  it("emits the accumulated total once the threshold is reached, then resets", () => {
    const grantor = newCreditGrantor(100);
    expect(grantor.consumed(20)).toBe(0);
    expect(grantor.consumed(30)).toBe(50);
    expect(grantor.consumed(10)).toBe(0);
  });

  it("honours a custom threshold fraction", () => {
    const grantor = newCreditGrantor(100, 0.25);
    expect(grantor.consumed(25)).toBe(25);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/flow-control.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/flow-control.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/webrun-streams/src/flow-control.ts`:

```ts
/**
 * Credit-based flow control, as a pair of pure state machines with no I/O.
 *
 * The sender holds a {@link CreditLedger}: it spends credit for every byte it
 * puts on the wire and stalls at zero. The receiver holds a
 * {@link CreditGrantor}: it counts bytes its consumer has actually drained and
 * says when to hand the sender more.
 *
 * A sender therefore cannot overrun a receiver's buffer, because it was never
 * granted permission to. That is the property a sender-side window cannot
 * offer: the receiver's capacity is not knowable to the sender unless the
 * receiver states it.
 */

/** Credit a peer may assume before its counterpart has advertised anything. */
export const INITIAL_CREDIT = 64 * 1024;

export interface CreditLedger {
  /** Bytes authorised by the peer and not yet spent. */
  readonly available: number;
  /**
   * Reserve `bytes` of credit. Resolves once that much is available; the
   * caller sends only after it resolves. Rejects if {@link fail} is called.
   */
  spend(bytes: number): Promise<void>;
  /** The peer authorised `bytes` more. */
  grant(bytes: number): void;
  /** Reject every pending and future spend — transport or stream is gone. */
  fail(err: Error): void;
}

interface Waiter {
  bytes: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

export function newCreditLedger(initial: number): CreditLedger {
  let available = initial;
  let failure: Error | undefined;
  const waiters: Waiter[] = [];

  // Waiters are released strictly in order. Letting a small spend overtake a
  // large one that arrived first would reorder the stream.
  const pump = (): void => {
    while (waiters.length > 0) {
      const next = waiters[0];
      if (!next || next.bytes > available) return;
      waiters.shift();
      available -= next.bytes;
      next.resolve();
    }
  };

  return {
    get available() {
      return available;
    },
    spend(bytes: number): Promise<void> {
      if (failure) return Promise.reject(failure);
      if (waiters.length === 0 && bytes <= available) {
        available -= bytes;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        waiters.push({ bytes, resolve, reject });
      });
    },
    grant(bytes: number): void {
      if (failure) return;
      available += bytes;
      pump();
    },
    fail(err: Error): void {
      failure ??= err;
      while (waiters.length > 0) {
        waiters.shift()?.reject(err);
      }
    },
  };
}

export interface CreditGrantor {
  /**
   * Record that the consumer drained `bytes`. Returns the credit to hand back
   * to the peer, or `0` to stay silent and keep accumulating.
   */
  consumed(bytes: number): number;
}

/**
 * Grants are batched: replenishing on every chunk would reinvent the
 * per-frame ACK this change exists to remove. `threshold` is the fraction of
 * the window that must drain before a grant is emitted.
 */
export function newCreditGrantor(window: number, threshold = 0.5): CreditGrantor {
  const trigger = Math.max(1, Math.floor(window * threshold));
  let pending = 0;
  return {
    consumed(bytes: number): number {
      pending += bytes;
      if (pending < trigger) return 0;
      const grant = pending;
      pending = 0;
      return grant;
    },
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/flow-control.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Export from the package index**

In `packages/webrun-streams/src/index.ts`, add the export alongside the others, keeping alphabetical order:

```ts
export * from "./flow-control.js";
```

- [ ] **Step 6: Run the full package suite and lint**

```bash
pnpm --filter @statewalker/webrun-streams test
pnpm --filter @statewalker/webrun-streams lint
```

Expected: all green. Nothing consumes the new module yet, so `emulateMux` is unaffected.

- [ ] **Step 7: Document the new exports**

`packages/webrun-streams/README.md` has an `## Exports` section (around line
276) with grouped tables. Add a new group after the "Seam types" table:

```markdown
### Flow control

| Export | Kind | Purpose |
| --- | --- | --- |
| `newCreditLedger(initial)` | function | Sender-side credit: `spend(bytes)` stalls at zero, `grant(bytes)` releases waiters in order, `fail(err)` unwinds them. |
| `CreditLedger` | type | `{ available, spend, grant, fail }`. |
| `newCreditGrantor(window, threshold?)` | function | Receiver-side: `consumed(bytes)` returns the credit to hand back, batched at `threshold` (default half the window) so grants do not become per-frame ACKs. |
| `CreditGrantor` | type | `{ consumed(bytes): number }`. |
| `INITIAL_CREDIT` | const | 64 KiB — what a peer may assume before its counterpart advertises. |
```

- [ ] **Step 8: Commit**

```bash
git add packages/webrun-streams/src/flow-control.ts \
        packages/webrun-streams/tests/flow-control.test.ts \
        packages/webrun-streams/src/index.ts \
        packages/webrun-streams/README.md
git commit -m "feat(streams): credit ledger and grantor for flow control

Pure state machines, no I/O: the sender spends credit and stalls at zero,
the receiver counts drained bytes and says when to grant more. Batched
grants so replenishment does not become a per-frame ACK under another name.

Not wired into emulateMux yet."
```

---

### Task 2: uint32 payload helpers for credit frames

**Files:**
- Modify: `packages/webrun-streams/src/emulate-mux.ts`
- Test: `packages/webrun-streams/tests/flow-control.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: module-private `encodeUint32(n: number): Uint8Array` and `decodeUint32(bytes: Uint8Array): number | undefined` inside `emulate-mux.ts`. `decodeUint32` returns `undefined` for a payload shorter than 4 bytes, so a truncated or legacy empty frame is detectable rather than being read as garbage.

- [ ] **Step 1: Write the failing tests**

Append to `packages/webrun-streams/tests/flow-control.test.ts`:

```ts
import { __testing } from "../src/emulate-mux.js";

describe("uint32 credit payloads", () => {
  it("round-trips a value", () => {
    const bytes = __testing.encodeUint32(8 * 1024 * 1024);
    expect(bytes.byteLength).toBe(4);
    expect(__testing.decodeUint32(bytes)).toBe(8 * 1024 * 1024);
  });

  it("round-trips zero and the maximum", () => {
    expect(__testing.decodeUint32(__testing.encodeUint32(0))).toBe(0);
    expect(__testing.decodeUint32(__testing.encodeUint32(0xffffffff))).toBe(0xffffffff);
  });

  it("returns undefined for a payload shorter than four bytes", () => {
    expect(__testing.decodeUint32(new Uint8Array(0))).toBeUndefined();
    expect(__testing.decodeUint32(new Uint8Array(3))).toBeUndefined();
  });

  it("reads the first four bytes when the payload is longer", () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 12345, false);
    expect(__testing.decodeUint32(bytes)).toBe(12345);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/flow-control.test.ts
```

Expected: FAIL — `__testing` is not exported from `emulate-mux.js`.

- [ ] **Step 3: Implement**

In `packages/webrun-streams/src/emulate-mux.ts`, add near the other module-level helpers (beside `encodeError`, around line 531):

```ts
/** Credit payloads are a single big-endian uint32, matching the frame header's byte order. */
function encodeUint32(n: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n >>> 0, false);
  return bytes;
}

/**
 * Returns `undefined` rather than a garbage number when the payload is too
 * short, so a truncated frame — or one from a peer predating credit — is
 * detectable at the call site instead of silently granting nonsense.
 */
function decodeUint32(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 4) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}

/** Internals exposed for unit tests only. Not part of the public API. */
export const __testing = { encodeUint32, decodeUint32 };
```

- [ ] **Step 4: Run and verify pass**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/flow-control.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-streams/src/emulate-mux.ts \
        packages/webrun-streams/tests/flow-control.test.ts
git commit -m "feat(streams): uint32 payload codec for credit frames

decodeUint32 returns undefined below four bytes so a truncated frame is
detectable rather than granting a garbage amount."
```

---

### Task 3: `OPEN` advertises the opener's receive capacity

**Files:**
- Modify: `packages/webrun-streams/src/emulate-mux.ts`
- Test: `packages/webrun-streams/tests/emulate-mux-credit.test.ts` (create)

**Interfaces:**
- Consumes: `encodeUint32`/`decodeUint32` (Task 2), `newCreditLedger`/`INITIAL_CREDIT` (Task 1).
- Produces: `Stream` gains `outboundCredit: CreditLedger`. `emulateMux` throws a `RangeError` from its constructor when `maxStreamBuffer < mtu`.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-streams/tests/emulate-mux-credit.test.ts`. It reuses the frame-tracing pipe pair from the existing backpressure test — copy that helper in verbatim rather than importing across test files:

```ts
import { describe, expect, it } from "vitest";
import { type ByteChannel, emulateMux } from "../src/index.js";

const FRAME_NAMES: Record<number, string> = {
  1: "OPEN",
  2: "DATA",
  3: "ACK",
  4: "END",
  5: "ERROR",
  6: "CLOSE",
};

/** Decodes the varint stream id so the type byte can be located. */
function frameInfo(frame: Uint8Array): { type: string; payload: Uint8Array } {
  let offset = 0;
  while (offset < frame.byteLength && (frame[offset] ?? 0) >= 0x80) offset += 1;
  offset += 1;
  const type = FRAME_NAMES[frame[offset] ?? 0] ?? "?";
  return { type, payload: frame.subarray(offset + 1) };
}

interface TracedPair {
  a: ByteChannel;
  b: ByteChannel;
  sent: { from: "a" | "b"; type: string; payload: Uint8Array }[];
}

function tracedPair(): TracedPair {
  const sent: TracedPair["sent"] = [];
  const queues: Record<"a" | "b", Uint8Array[]> = { a: [], b: [] };
  const pending: Record<"a" | "b", ((r: IteratorResult<Uint8Array>) => void) | null> = {
    a: null,
    b: null,
  };
  let closed = false;
  const closers: (() => void)[] = [];
  const closedPromise = new Promise<void>((r) => closers.push(r));

  const deliver = (to: "a" | "b", bytes: Uint8Array): void => {
    if (closed) return;
    const waiting = pending[to];
    if (waiting) {
      pending[to] = null;
      waiting({ value: bytes, done: false });
    } else queues[to].push(bytes);
  };

  const makeChannel = (self: "a" | "b", peer: "a" | "b"): ByteChannel => ({
    send(bytes) {
      const { type, payload } = frameInfo(bytes);
      sent.push({ from: self, type, payload: new Uint8Array(payload) });
      deliver(peer, new Uint8Array(bytes));
    },
    recv: {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const queued = queues[self].shift();
          if (queued) {
            yield queued;
            continue;
          }
          const nextValue = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending[self] = resolve;
          });
          if (nextValue.done) return;
          yield nextValue.value;
        }
      },
    },
    closed: closedPromise,
    close() {
      closed = true;
      for (const c of closers) c();
      pending.a?.({ value: undefined as never, done: true });
      pending.b?.({ value: undefined as never, done: true });
    },
  });

  return { a: makeChannel("a", "b"), b: makeChannel("b", "a"), sent };
}

describe("credit advertisement", () => {
  it("rejects a configuration whose maxStreamBuffer is below one mtu", () => {
    const { a } = tracedPair();
    expect(() => emulateMux(a, { mtu: 1024, maxStreamBuffer: 512 })).toThrow(RangeError);
  });

  it("accepts maxStreamBuffer exactly equal to mtu", () => {
    const { a } = tracedPair();
    expect(() => emulateMux(a, { mtu: 1024, maxStreamBuffer: 1024 })).not.toThrow();
  });

  it("puts the opener's maxStreamBuffer in the OPEN payload", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 1 << 20 });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    const gen = client.call([new Uint8Array([1])]);
    await gen.next();

    const open = sent.find((f) => f.from === "a" && f.type === "OPEN");
    expect(open).toBeDefined();
    const view = new DataView(
      (open as { payload: Uint8Array }).payload.buffer,
      (open as { payload: Uint8Array }).payload.byteOffset,
    );
    expect(view.getUint32(0, false)).toBe(1 << 20);

    await gen.return(undefined as never);
    await client.close();
    await server.close();
  });

  it("replies to OPEN with an ACK carrying the responder's maxStreamBuffer", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 2 << 20 });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    const gen = client.call([new Uint8Array([1])]);
    await gen.next();

    const ack = sent.find((f) => f.from === "b" && f.type === "ACK");
    expect(ack).toBeDefined();
    const payload = (ack as { payload: Uint8Array }).payload;
    const view = new DataView(payload.buffer, payload.byteOffset);
    expect(view.getUint32(0, false)).toBe(2 << 20);

    await gen.return(undefined as never);
    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-credit.test.ts
```

Expected: FAIL — the constructor does not throw, `OPEN` has an empty payload, no `ACK` follows `OPEN`.

- [ ] **Step 3: Implement**

In `packages/webrun-streams/src/emulate-mux.ts`:

**3a.** Import the ledger. Add to the existing import from `./errors.js` area, as a new line:

```ts
import { type CreditLedger, INITIAL_CREDIT, newCreditLedger } from "./flow-control.js";
```

**3b.** Add the invariant right after `maxStreamBuffer` is read (currently line 123):

```ts
  // Both peers assume INITIAL_CREDIT before the other has advertised. That is
  // only sound if every peer can actually hold one mtu, so refuse a config
  // that cannot. This constrains one peer's own two settings against each
  // other — it is not a claim about the far side, which is unknowable here.
  if (maxStreamBuffer < mtu) {
    throw new RangeError(
      `emulateMux: maxStreamBuffer=${maxStreamBuffer} is below mtu=${mtu}; a stream could not hold one frame`,
    );
  }
```

**3c.** Add the field to the `Stream` interface (beside `queuedBytes`):

```ts
  /** Credit the peer has granted us for sending on this stream. */
  outboundCredit: CreditLedger;
```

**3d.** Initialise it in `createStream`, beside `queuedBytes: 0`:

```ts
    outboundCredit: newCreditLedger(INITIAL_CREDIT),
```

**3e.** In `call`, carry the advertisement (replace `sendFrame(id, TYPE_OPEN);`):

```ts
    sendFrame(id, TYPE_OPEN, encodeUint32(maxStreamBuffer));
```

**3f.** In the inbound `TYPE_OPEN` branch, after `streams.set(id, s);` and before `void runHandler(s, handler);`:

```ts
      // The opener's advertisement raises our sending allowance; ours goes
      // back so the opener can raise its own past INITIAL_CREDIT.
      const advertised = decodeUint32(payload);
      if (advertised !== undefined) s.outboundCredit.grant(advertised - INITIAL_CREDIT);
      sendFrame(id, TYPE_ACK, encodeUint32(maxStreamBuffer));
```

- [ ] **Step 4: Run and verify pass**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-credit.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Confirm nothing else regressed yet**

```bash
pnpm --filter @statewalker/webrun-streams test
```

Expected: all green. `pumpOutbound` still awaits an ACK per frame, so behaviour is unchanged; the extra `ACK` after `OPEN` is absorbed because a stray ACK with no waiter is a no-op (`r?.()` on a null `resolveAck`).

If `emulate-mux-backpressure.test.ts` fails here, stop: the extra ACK is being counted by a frame-count assertion. Note which test and handle it in Task 4, where that file is rewritten.

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-streams/src/emulate-mux.ts \
        packages/webrun-streams/tests/emulate-mux-credit.test.ts
git commit -m "feat(streams): advertise receive capacity on OPEN and its ACK reply

Each side tells the peer how much it can hold, so the peer can send more
than one frame without guessing. Adds the local invariant that
maxStreamBuffer >= mtu, which is what makes the INITIAL_CREDIT assumption
sound before an advertisement arrives.

Sender still awaits an ACK per frame; behaviour is unchanged so far."
```

---

### Task 4: Sender spends credit; receiver grants on drain

This is the behavioural change. It **deliberately breaks** `emulate-mux-backpressure.test.ts`'s "holds exactly one DATA frame in flight while the peer never acks", which pins the stop-and-wait contract. That test is rewritten here to pin the credit bound instead — the new contract, not a weakened one.

**Files:**
- Modify: `packages/webrun-streams/src/emulate-mux.ts`
- Modify: `packages/webrun-streams/tests/emulate-mux-backpressure.test.ts`

**Interfaces:**
- Consumes: `Stream.outboundCredit` (Task 3), `newCreditGrantor` (Task 1).
- Produces: `Stream` gains `grantor: CreditGrantor`. `pumpOutbound` no longer awaits per frame.

- [ ] **Step 1: Rewrite the test that pins stop-and-wait**

In `packages/webrun-streams/tests/emulate-mux-backpressure.test.ts`, replace the whole `it("holds exactly one DATA frame in flight while the peer never acks", ...)` block with:

```ts
  it("sends up to the advertised credit and no further while the peer never drains", async () => {
    const { a, b, frames } = pipePair();
    // 4 frames' worth of credit: the sender may fill it, then must stop.
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, {
      side: "responder",
      mtu: 64 * 1024,
      maxStreamBuffer: 4 * 64 * 1024,
    });
    server.serve(async function* neverDrains() {
      await new Promise((r) => setTimeout(r, 5_000));
    });

    const gen = client.call(
      (async function* () {
        for (let i = 0; i < 50; i++) yield new Uint8Array(64 * 1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* stream torn down */
      }
    })();
    await new Promise((r) => setTimeout(r, 60));

    // Unbounded sending would put all 50 on the wire. Credit bounds it to the
    // advertised window, and the consumer never drains so none is returned.
    const sentData = frames.filter((f) => f === "A>B:DATA").length;
    expect(sentData).toBeGreaterThan(1);
    expect(sentData).toBeLessThanOrEqual(4);

    await client.close();
    await server.close();
  });
```

Also update the file's header comment, which currently describes the old contract:

```ts
// Flow control here is receiver-advertised credit: each side tells the peer how
// much it may hold (OPEN payload, and the ACK that answers it), the sender
// spends that credit and stalls at zero, and the receiver grants more only once
// its consumer has actually drained — `slot.resolve(true)` runs after the
// `yield` returns. Without it a fast producer would run ahead of a slow
// consumer without limit.
//
// None of this was pinned by any test: removing the ACK await from
// pumpOutbound entirely left the whole suite green. These cover it.
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-backpressure.test.ts
```

Expected: FAIL on the rewritten test — `expect(sentData).toBeGreaterThan(1)` gets `1`, because the sender still waits per frame. The other four tests in the file should still pass.

- [ ] **Step 3: Implement the sender side**

In `packages/webrun-streams/src/emulate-mux.ts`, replace the inner `while (off < chunk.byteLength)` body of `pumpOutbound` (currently lines 210–221):

```ts
        let off = 0;
        while (off < chunk.byteLength) {
          if (s.closed || muxClosed) return;
          const end = Math.min(off + mtu, chunk.byteLength);
          const piece = chunk.subarray(off, end);
          // Reserve before sending. This is where a sender stalls when the
          // peer's buffer is full — it never sends bytes it was not granted.
          await s.outboundCredit.spend(piece.byteLength);
          if (s.closed || muxClosed) return;
          sendFrame(s.id, TYPE_DATA, piece);
          off = end;
        }
```

- [ ] **Step 4: Implement the receiver side**

**4a.** Add to the `Stream` interface, beside `outboundCredit`:

```ts
  /** Tracks consumer drainage to decide when to grant the peer more credit. */
  grantor: CreditGrantor;
```

**4b.** Import it, extending the Task 3 import line:

```ts
import {
  type CreditGrantor,
  type CreditLedger,
  INITIAL_CREDIT,
  newCreditGrantor,
  newCreditLedger,
} from "./flow-control.js";
```

**4c.** Initialise in `createStream`, beside `outboundCredit`:

```ts
    grantor: newCreditGrantor(maxStreamBuffer),
```

**4d.** Replace the `pushIn` continuation in the `TYPE_DATA` branch (currently lines 340–343):

```ts
        void s.pushIn(copy).then((handled) => {
          s.queuedBytes -= copy.byteLength;
          if (!handled || s.closed || muxClosed) return;
          // Grant only for bytes the consumer actually took, and only in
          // batches — granting per chunk would be the per-frame ACK again.
          const grant = s.grantor.consumed(copy.byteLength);
          if (grant > 0) sendFrame(id, TYPE_ACK, encodeUint32(grant));
        });
```

**4e.** Replace the `TYPE_ACK` branch (currently lines 346–352):

```ts
      case TYPE_ACK: {
        const granted = decodeUint32(payload);
        // A payload-less ACK is not from a credit-speaking peer; ignore it
        // rather than granting an arbitrary amount.
        if (granted !== undefined) s.outboundCredit.grant(granted);
        return;
      }
```

**4f.** `resolveAck`/`rejectAck` on `Stream` are now unused. Delete both fields, their initialisers in `createStream`, and the two lines in `teardownStream` that resolve or reject them — replacing those with a ledger failure so a stalled sender unwinds:

```ts
    s.outboundCredit.fail(err ?? new Error("emulateMux: stream closed"));
```

- [ ] **Step 5: Run the rewritten test and verify it passes**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-backpressure.test.ts
```

Expected: PASS, 5 tests. The three "slow consumer throttles the producer" tests must still pass — they assert throttling, not lock-step, so credit satisfies them.

- [ ] **Step 6: Run the whole package suite**

```bash
pnpm --filter @statewalker/webrun-streams test
```

Expected: all green, including `emulate-mux-hostile.test.ts`'s "caps what one undrained stream may buffer" — the cap still fires for a peer that ignores credit, which is Task 7's subject.

- [ ] **Step 7: Update the two READMEs that describe the old behaviour**

In `packages/webrun-streams/README.md`, the `## \`emulateMux\`` section and its
"Flow control" subsection describe one-in-flight-per-stream. Replace the
flow-control description with:

```markdown
Flow control is receiver-advertised credit. Each side puts its
`maxStreamBuffer` in the `OPEN` frame (and in the `ACK` that answers it), the
sender spends that credit as it sends and stalls at zero, and the receiver
grants more once its consumer has actually drained — batched at half the
window. A sender therefore cannot overrun the receiver's buffer, and
`maxStreamBuffer` bounds only peers that ignore the protocol.

Backpressure is end-to-end: the grant derives from `newAsyncGenerator`'s
`next()` resolving, which happens when the consumer pulls again. A producer may
run up to one credit window ahead of its consumer, not further.
```

In the root `README.md`, the `webrun-streams` package summary describes
`emulateMux` as "multi-stream over a single channel, with backpressure, a
64 KiB default MTU and an 8 MiB per-stream buffer". Change that phrase to
"multi-stream over a single channel, with receiver-advertised credit flow
control, a 64 KiB default MTU and an 8 MiB per-stream buffer".

- [ ] **Step 8: Lint and commit**

```bash
pnpm --filter @statewalker/webrun-streams lint
git add packages/webrun-streams/src/emulate-mux.ts \
        packages/webrun-streams/tests/emulate-mux-backpressure.test.ts \
        packages/webrun-streams/README.md \
        README.md
git commit -m "feat(streams)!: spend receiver-granted credit instead of one ACK per frame

pumpOutbound now reserves credit before sending and stalls at zero; the
receiver grants in batches once its consumer has drained. Single-stream
throughput stops being one round trip per 64 KiB frame.

Backpressure is preserved at coarser granularity: the producer may run one
credit window ahead of the consumer rather than exactly zero.

BREAKING: OPEN and ACK carry uint32 payloads. Peers predating this cannot
interoperate. Replaces the test pinning one-frame-in-flight with one
pinning the credit bound."
```

---

### Task 5: A stalled consumer resumes when credit is granted

Task 4 proved a sender stops at the credit bound. This proves it *starts again* — the half of the contract a stall test cannot show.

**Files:**
- Modify: `packages/webrun-streams/tests/emulate-mux-credit.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–4. Produces nothing new.

- [ ] **Step 1: Write the failing test**

Append to `packages/webrun-streams/tests/emulate-mux-credit.test.ts`:

```ts
describe("credit replenishment", () => {
  it("a sender stalled at zero credit resumes once the consumer drains", async () => {
    const { a, b } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, {
      side: "responder",
      mtu: 1024,
      maxStreamBuffer: 4 * 1024,
    });

    let received = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    server.serve(async function* counting(input) {
      await gate;
      for await (const chunk of input) received += chunk.byteLength;
    });

    const total = 40;
    const gen = client.call(
      (async function* () {
        for (let i = 0; i < total; i++) yield new Uint8Array(1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    // Consumer is gated: the sender fills the window and stalls well short.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(0);

    // Open the gate; grants flow and the whole stream must complete.
    release();
    const deadline = Date.now() + 2000;
    while (received < total * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toBe(total * 1024);

    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Before running, temporarily comment out the `if (grant > 0) sendFrame(id, TYPE_ACK, encodeUint32(grant));` line added in Task 4 step 4d, so no credit is ever returned.

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-credit.test.ts
```

Expected: FAIL — `received` stalls below `total * 1024` and the deadline expires. This confirms the test genuinely depends on replenishment rather than passing for unrelated reasons.

- [ ] **Step 3: Restore the grant line**

Uncomment the line commented out in Step 2. No other change.

- [ ] **Step 4: Run and verify it passes**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-credit.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-streams/tests/emulate-mux-credit.test.ts
git commit -m "test(streams): a stalled sender resumes when credit is granted

Pins the other half of the contract: Task 4 proved the sender stops at the
bound, this proves grants restart it and the stream completes."
```

---

### Task 6: Asymmetrically configured peers interoperate

This is the case the rejected sender-side window got wrong (spec Decision 8), so it is asserted explicitly rather than assumed.

**Files:**
- Modify: `packages/webrun-streams/tests/emulate-mux-credit.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4. Produces nothing new.

- [ ] **Step 1: Write the failing test**

Append to `packages/webrun-streams/tests/emulate-mux-credit.test.ts`:

```ts
describe("asymmetric configuration", () => {
  it("a large-buffer sender and a small-buffer receiver transfer without teardown", async () => {
    const { a, b } = tracedPair();
    // The sender would happily hold 8 MiB; the receiver can hold 4 KiB.
    // Under a sender-side window each peer's local check passes and the
    // stream is torn down. Under credit the sender is simply granted less.
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 8 * 1024 * 1024 });
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4 * 1024 });

    let received = 0;
    server.serve(async function* counting(input) {
      for await (const chunk of input) received += chunk.byteLength;
    });

    const total = 64;
    const gen = client.call(
      (async function* () {
        for (let i = 0; i < total; i++) yield new Uint8Array(1024);
      })(),
    );
    const errors: unknown[] = [];
    await (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch (err) {
        errors.push(err);
      }
    })();

    const deadline = Date.now() + 2000;
    while (received < total * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(errors).toEqual([]);
    expect(received).toBe(total * 1024);

    await client.close();
    await server.close();
  });
});
```

> **This is a regression test, not a TDD cycle.** It pins a property the design
> provides by construction, so it has no red phase. The red/green requirement
> applies to new behaviour (Tasks 1–5).

- [ ] **Step 2: Run and verify it passes**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-credit.test.ts
```

Expected: PASS, 6 tests. This test is expected to pass immediately — it documents a property the design provides by construction. If it *fails*, the credit accounting is wrong and Task 4 must be revisited before continuing.

- [ ] **Step 3: Commit**

```bash
git add packages/webrun-streams/tests/emulate-mux-credit.test.ts
git commit -m "test(streams): asymmetrically configured peers interoperate

The case a sender-side window gets wrong: both peers pass their own local
checks and streams still die. Credit makes it a non-event."
```

---

### Task 7: The buffer cap still defends against peers ignoring credit

`maxStreamBuffer` must keep its original job while never firing for peers that
honour credit. `emulate-mux-hostile.test.ts` already has the test that proves
it — "caps what one undrained stream may buffer, and spares the rest of the
mux" — so this task verifies it survived Task 4 and updates its now-wrong
explanation, rather than adding a near-duplicate.

Note that its injected `OPEN` frame is `[0x03, 0x01]` — **no payload**. That is
precisely the case `decodeUint32` returns `undefined` for (Task 2), so the
responder skips the grant instead of reading garbage. If this test passes, that
design choice is load-bearing and confirmed.

> **This is a regression test, not a TDD cycle.** It has no red phase because
> the behaviour predates this plan; the point is to prove it was not lost. The
> red/green requirement applies to new behaviour (Tasks 1–5).

**Files:**
- Modify: `packages/webrun-streams/tests/emulate-mux-hostile.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4. Produces nothing new.

- [ ] **Step 1: Run the existing hostile suite unchanged**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-hostile.test.ts
```

Expected: PASS, 4 tests — in particular "caps what one undrained stream may
buffer, and spares the rest of the mux".

If it **fails**, stop and fix Task 4: the `queuedBytes` accounting behind the
cap must stay independent of credit, because a hostile peer by definition does
not participate in credit. Do not weaken the test.

- [ ] **Step 2: Update the stale explanation**

That test's opening comment still describes the old contract. Replace its first
three comment lines:

```ts
    // Credit is voluntary: the peer is meant to spend only what was granted
    // and wait for more. A hostile peer does not — this one never even sends a
    // credit payload on OPEN — and pushes are fire-and-forget, so without a cap
    // one stream retains everything sent.
```

- [ ] **Step 3: Strengthen the assertion**

Immediately after the existing `expect(refusal, ...).toBeDefined();` line, add:

```ts
    // The flood was never granted: the injected OPEN carried no credit
    // payload, so the responder granted nothing and the peer sent anyway.
    // The cap is what stopped it, not flow control.
    const TYPE_ACK = 0x03;
    const grants = sentToA.filter((f) => f[0] === 0x03 && f[1] === TYPE_ACK);
    expect(grants.length).toBeLessThanOrEqual(1); // at most the OPEN reply
```

- [ ] **Step 4: Run and verify still green**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-hostile.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-streams/tests/emulate-mux-hostile.test.ts
git commit -m "test(streams): pin that the buffer cap survived the credit change

Credit bounds cooperative peers; maxStreamBuffer bounds the rest. The
injected OPEN carries no credit payload, so this also exercises
decodeUint32 returning undefined rather than granting garbage."
```

---

### Task 8: Conformance coverage for flow control

**Files:**
- Modify: `packages/webrun-streams-conformance/src/describe-duplex-adapter.ts`

**Interfaces:**
- Consumes: `DescribeDuplexAdapterOptions` (existing: `concurrency`, `skipHugeBody`).
- Produces: no signature change. Every adapter's one-line test file keeps working untouched.

- [ ] **Step 1: Write the failing test**

Add a new level to `packages/webrun-streams-conformance/src/describe-duplex-adapter.ts`, after the existing `describe("L5: transport teardown", ...)` block:

```ts
  describe("L6: flow control", () => {
    it("delivers a large body intact to a consumer that drains slowly", async () => {
      const pair = await makePair();
      try {
        await pair.serve(async function* echo(input) {
          for await (const chunk of input) yield chunk;
        });
        const size = 512 * 1024;
        const body = new Uint8Array(size);
        for (let i = 0; i < size; i++) body[i] = i & 0xff;

        const { call, close } = await pair.connect();
        const out = call([body]);
        const received: number[] = [];
        for await (const chunk of out) {
          // Drain deliberately slowly so the sender must stall on credit and
          // resume on grants rather than streaming through in one burst.
          await new Promise((r) => setTimeout(r, 1));
          for (const byte of chunk) received.push(byte);
        }

        expect(received.length).toBe(size);
        expect(received[0]).toBe(0);
        expect(received[size - 1]).toBe((size - 1) & 0xff);
        await close();
      } finally {
        await pair.close();
      }
    });
  });
```

- [ ] **Step 2: Run against the two ungated adapters**

```bash
pnpm --filter @statewalker/webrun-streams-conformance test
pnpm --filter @statewalker/webrun-streams-ws test
pnpm --filter @statewalker/webrun-streams-port test
```

Expected: PASS on all three. The loopback pair has no flow control at all and must still satisfy it — that is the suite's own self-test.

- [ ] **Step 3: Run the gated suites deliberately**

These do not run under a plain `pnpm test` and are the only coverage for four of the six adapters. **Do not skip this step** — `emulateMux` changed underneath all of them.

```bash
WEBRUN_STREAMS_LIBP2P=1 pnpm --filter @statewalker/webrun-streams-libp2p test
pnpm --filter @statewalker/webrun-streams-webrtc test:browser
pnpm --filter @statewalker/webrun-streams-peerjs test:browser
# LiveKit additionally needs a running server; see its README for the
# WEBRUN_STREAMS_LIVEKIT_* variables.
pnpm --filter @statewalker/webrun-streams-livekit test:browser
```

Record the outcome of each in the commit message. If a gated suite cannot be run in this environment, say so explicitly rather than implying it passed.

- [ ] **Step 4: Document the new level**

In `packages/webrun-streams-conformance/README.md`, add to the `## Levels
asserted` list after the L5 bullet:

```markdown
- **L6** Flow control — a 512 KiB body reaches a deliberately slow consumer
  intact, so the sender must stall on credit and resume on grants rather than
  streaming through in one burst.
```

In the same file's API table, change "Registers the whole L0–L5 suite for one
adapter" to "Registers the whole L0–L6 suite for one adapter".

In the root `README.md`, the `webrun-streams-conformance` summary lists "six
levels" — update it to seven and mention flow control alongside the existing
list.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-streams-conformance/src/describe-duplex-adapter.ts \
        packages/webrun-streams-conformance/README.md \
        README.md
git commit -m "test(conformance): L6 covers flow control against a slow consumer

512 KiB through a deliberately slow drain, so the sender must stall on
credit and resume on grants. Runs on every adapter, including the loopback
reference which has no flow control and must still satisfy it."
```

---

### Task 9: Move `MessageTarget` into `webrun-streams`

Independent of Tasks 1–8; can be done at any point. Spec Decision 7.

**Files:**
- Create: `packages/webrun-streams/src/message-target.ts`
- Modify: `packages/webrun-streams/src/index.ts`
- Modify: `packages/webrun-http-browser/src/core/message-target.ts`

**Interfaces:**
- Produces: `MessageListener`, `MessageSource`, `MessageSink`, `MessageTarget` exported from `@statewalker/webrun-streams`. `webrun-http-browser` re-exports them from its existing path, so its five internal importers are untouched.

- [ ] **Step 1: Write the failing test**

Create `packages/webrun-streams/tests/message-target.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/index.js";

describe("MessageTarget", () => {
  it("is satisfied structurally by a MessagePort", () => {
    const { port1 } = new MessageChannel();
    // Compile-time assertion: if MessagePort does not satisfy the interface,
    // this file fails to typecheck. The runtime assertion keeps vitest honest.
    const target: MessageTarget = port1;
    expect(typeof target.postMessage).toBe("function");
    expect(typeof target.addEventListener).toBe("function");
    port1.close();
  });

  it("is satisfied by a minimal hand-rolled object", () => {
    const target: MessageTarget = {
      postMessage() {},
      addEventListener() {},
      removeEventListener() {},
    };
    expect(typeof target.postMessage).toBe("function");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/message-target.test.ts
```

Expected: FAIL — `MessageTarget` is not exported from `webrun-streams`.

**If the first test fails to typecheck** rather than failing at runtime, `MessagePort` does not satisfy the interface structurally (most likely the `addEventListener` overloads). That is a real finding the spec anticipated: record it, and add a `messageTargetFromMessagePort` adapter in `webrun-streams-port` in a follow-up task rather than loosening the interface here.

- [ ] **Step 3: Create the module**

Create `packages/webrun-streams/src/message-target.ts` with exactly the content currently in `packages/webrun-http-browser/src/core/message-target.ts`:

```ts
export type MessageListener = (event: MessageEvent) => void | Promise<void>;

/** An object we can listen for `"message"` events on. */
export interface MessageSource {
  addEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  start?(): void | Promise<void>;
}

/** An object we can post messages to (with optional transferable list). */
export interface MessageSink {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** Full-duplex message target: both sends and receives. */
export interface MessageTarget extends MessageSource, MessageSink {
  close?(): void | Promise<void>;
}
```

- [ ] **Step 4: Export it**

In `packages/webrun-streams/src/index.ts`, add in alphabetical position:

```ts
export * from "./message-target.js";
```

- [ ] **Step 5: Run and verify pass**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/message-target.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Turn the http-browser copy into a re-export**

Replace the entire contents of `packages/webrun-http-browser/src/core/message-target.ts` with:

```ts
// Moved to @statewalker/webrun-streams so webrun-rpc and webrun-streams-port
// can use these without depending on this package. Re-exported here so the
// five internal importers, and this package's public API, are unchanged.
export type {
  MessageListener,
  MessageSink,
  MessageSource,
  MessageTarget,
} from "@statewalker/webrun-streams";
```

- [ ] **Step 7: Verify http-browser still builds and passes**

```bash
pnpm --filter @statewalker/webrun-http-browser test
pnpm --filter @statewalker/webrun-http-browser run build
```

Expected: green. `@statewalker/webrun-streams` is already a dependency of `webrun-http-browser`, so no manifest change is needed — confirm with:

```bash
node -e 'console.log(Object.keys(require("./packages/webrun-http-browser/package.json").dependencies))'
```

- [ ] **Step 8: Update both READMEs**

In `packages/webrun-streams/README.md`, add to the `## Exports` section a group
after "Flow control":

```markdown
### Message passing

| Export | Kind | Purpose |
| --- | --- | --- |
| `MessageTarget` | interface | Full-duplex structural view of a message endpoint — a `MessagePort`, a `Worker`, or a ServiceWorker bridge. Extends `MessageSource` and `MessageSink`. |
| `MessageSource` | interface | `addEventListener`/`removeEventListener` for `"message"`, plus optional `start()`. |
| `MessageSink` | interface | `postMessage(message, transfer?)`. |
| `MessageListener` | type | `(event: MessageEvent) => void \| Promise<void>`. |

These are types only — no runtime code — so `webrun-streams` keeps zero
dependencies. They live here rather than in `webrun-streams-port` so packages
that are not port-specific can use them without depending on that adapter.
```

In `packages/webrun-http-browser/README.md`, the "Messaging primitives" table
row for `MessageTarget`/`MessageSource`/`MessageSink`/`MessageListener` should
note the move. Replace its Purpose cell with:

```markdown
The structural port view everything above accepts — a `MessagePort`, a `Worker`, or a SW bridge. Defined in [`@statewalker/webrun-streams`](../webrun-streams) and re-exported here.
```

- [ ] **Step 9: Lint and commit**

```bash
pnpm lint
git add packages/webrun-streams/src/message-target.ts \
        packages/webrun-streams/tests/message-target.test.ts \
        packages/webrun-streams/src/index.ts \
        packages/webrun-http-browser/src/core/message-target.ts \
        packages/webrun-streams/README.md \
        packages/webrun-http-browser/README.md
git commit -m "refactor(streams): move MessageTarget into the foundation

webrun-rpc and webrun-streams-port both need this seam, and having it in
webrun-http-browser would make them depend on the browser package.
Zero-runtime-code type module, so webrun-streams keeps zero dependencies.

webrun-http-browser re-exports from its old path; its five importers and
its public API are unchanged."
```

---

### Task 10: Full verification sweep

**Files:** none modified.

- [ ] **Step 1: Clean build of every package**

```bash
rm -rf packages/*/dist
pnpm -r run build
```

Expected: exit 0, every package emitting `dist/index.js` and `dist/index.d.ts`.

- [ ] **Step 2: Full test suite**

```bash
pnpm -r run test
```

Expected: no failures. Baseline before this plan was 643 passing with browser/vendor-gated skips in `-webrtc`, `-peerjs`, `-livekit` and one in `-libp2p`. The count rises by the new tests; the skip set must not grow.

- [ ] **Step 3: Confirm the zero-dependency invariant held**

```bash
node -e 'const p=require("./packages/webrun-streams/package.json");
const d={...p.dependencies,...p.peerDependencies};
console.log(Object.keys(d).length===0?"OK: zero runtime deps":"REGRESSION: "+Object.keys(d))'
```

Expected: `OK: zero runtime deps`.

- [ ] **Step 4: Lint**

```bash
pnpm lint:check
```

Expected: no new diagnostics in files this plan touched. There is a pre-existing baseline of 19 errors / 9 warnings in files unrelated to this work (`p2p-demo/lib/join-group.ts`, `http1/encode.ts`, `biome.json`, `livekit-demo` HTML a11y, and formatting in several test files). Compare against that baseline rather than expecting zero.

- [ ] **Step 5: Verify the READMEs match the code**

Every public export must appear in its package's README, which is the standard
these READMEs were brought to. This resolves each `index.ts`'s re-export chain
and reports anything undocumented:

```bash
node -e '
const fs=require("node:fs"),path=require("node:path");
const readIf=p=>fs.existsSync(p)?fs.readFileSync(p,"utf8"):null;
const resolve=(spec,from)=>{const b=path.resolve(path.dirname(from),spec.replace(/\.js$/,""));
  for(const c of [b+".ts",path.join(b,"index.ts")]) if(fs.existsSync(c)) return c; return null;};
const surface=(f,seen=new Set())=>{if(!f||seen.has(f))return[];seen.add(f);
  const src=readIf(f);if(!src)return[];const out=[];
  for(const m of src.matchAll(/^export\s+\*\s+from\s+["\x27]([^"\x27]+)["\x27]/gm)) out.push(...surface(resolve(m[1],f),seen));
  for(const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for(const part of m[1].split(",")){
    const t=part.trim().replace(/^type\s+/,"").split(/\s+as\s+/).pop().trim(); if(t) out.push(t);}
  for(const m of src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/gm)) out.push(m[1]);
  return out;};
let bad=0;
for(const pkg of fs.readdirSync("packages").sort()){
  const idx=`packages/${pkg}/src/index.ts`; if(!fs.existsSync(idx)) continue;
  const syms=[...new Set(surface(idx))].filter(x=>x!=="__testing");
  const rd=readIf(`packages/${pkg}/README.md`)??"";
  const missing=syms.filter(x=>!new RegExp("\\b"+x.replace(/\$/g,"\\$")+"\\b").test(rd));
  if(missing.length){bad++;console.log(pkg,"UNDOCUMENTED:",missing.join(" "));}
}
console.log(bad===0?"OK: every public export is documented":"REGRESSION: "+bad+" package(s)");
'
```

Expected: `OK: every public export is documented`. If anything is listed, the
task that added it skipped its documentation step — go back and fix that
commit's README rather than patching it here.

- [ ] **Step 6: Confirm the umbrella needs no change**

This plan creates no package and renames no repository, so the umbrella's
registry and durable documents are untouched. Confirm:

```bash
git -C ../../.. status --porcelain
```

Expected: empty. If `repos.json` or `docs/multirepo/MODEL.md` shows as modified,
something in this plan exceeded its scope — stop and review.

- [ ] **Step 7: Add a changeset**

```bash
pnpm changeset
```

Select `@statewalker/webrun-streams` (minor — new exports, breaking wire format on a 0.x line), `@statewalker/webrun-streams-conformance` (minor — new L6), `@statewalker/webrun-http-browser` (patch — internal re-export only). Describe the wire-format break explicitly in the summary.

- [ ] **Step 8: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for credit-based flow control

Wire format changed: OPEN and ACK carry uint32 credit payloads. Peers
predating this cannot interoperate."
```
