import { describe, expect, it } from "vitest";
import { newCreditGrantor, newCreditLedger } from "../src/flow-control.js";

describe("newCreditLedger", () => {
  it("starts at zero and blocks the first reservation until a grant arrives", async () => {
    const ledger = newCreditLedger();
    expect(ledger.available).toBe(0);
    let granted = -1;
    const pending = ledger.reserve(40).then((n) => {
      granted = n;
    });
    await Promise.resolve();
    expect(granted).toBe(-1);

    ledger.grant(100);
    await pending;
    expect(granted).toBe(40);
    expect(ledger.available).toBe(60);
  });

  it("grants a partial reservation rather than waiting for the full amount", async () => {
    const ledger = newCreditLedger();
    ledger.grant(30);
    expect(await ledger.reserve(80)).toBe(30);
    expect(ledger.available).toBe(0);
  });

  it("releases a waiter partially, so an over-window request still progresses", async () => {
    const ledger = newCreditLedger();
    const first = ledger.reserve(64 * 1024);
    ledger.grant(4096);
    expect(await first).toBe(4096);
    const second = ledger.reserve(64 * 1024 - 4096);
    ledger.grant(4096);
    expect(await second).toBe(4096);
  });

  it("releases waiters strictly in order", async () => {
    const ledger = newCreditLedger();
    const order: number[] = [];
    const first = ledger.reserve(10).then((n) => order.push(1 * n));
    const second = ledger.reserve(10).then((n) => order.push(2 * n));

    ledger.grant(10);
    await first;
    expect(order).toEqual([10]);

    ledger.grant(10);
    await second;
    expect(order).toEqual([10, 20]);
  });

  it("does not let a later reservation overtake a queued one", async () => {
    const ledger = newCreditLedger();
    const head = ledger.reserve(100);
    let tailDone = false;
    void ledger.reserve(1).then(() => {
      tailDone = true;
    });
    ledger.grant(1);
    expect(await head).toBe(1);
    expect(tailDone).toBe(false);
  });

  it("rejects a reservation of less than one unit", async () => {
    const ledger = newCreditLedger();
    ledger.grant(100);
    await expect(ledger.reserve(0)).rejects.toThrow(RangeError);
    // Nothing was consumed: not credit, and not a waiter slot.
    expect(ledger.available).toBe(100);
  });

  it("rejects pending reservations when failed", async () => {
    const ledger = newCreditLedger();
    const pending = ledger.reserve(10);
    ledger.fail(new Error("transport closed"));
    await expect(pending).rejects.toThrow("transport closed");
  });

  it("rejects later reservations once failed", async () => {
    const ledger = newCreditLedger();
    ledger.grant(1000);
    ledger.fail(new Error("gone"));
    await expect(ledger.reserve(1)).rejects.toThrow("gone");
  });
});

describe("newCreditGrantor", () => {
  it("accumulates silently below the threshold while the queue is non-empty", () => {
    const grantor = newCreditGrantor(100);
    expect(grantor.consumed(20, false)).toBe(0);
    expect(grantor.consumed(20, false)).toBe(0);
  });

  it("emits the accumulated total once the threshold is reached, then resets", () => {
    const grantor = newCreditGrantor(100);
    expect(grantor.consumed(20, false)).toBe(0);
    expect(grantor.consumed(30, false)).toBe(50);
    expect(grantor.consumed(10, false)).toBe(0);
  });

  it("flushes a sub-threshold batch as soon as the queue empties", () => {
    const grantor = newCreditGrantor(1024);
    expect(grantor.consumed(300, false)).toBe(0);
    expect(grantor.consumed(0, true)).toBe(300);
  });

  it("stays silent on an empty queue when nothing is pending", () => {
    const grantor = newCreditGrantor(1024);
    expect(grantor.consumed(0, true)).toBe(0);
  });

  it("honours a custom threshold fraction", () => {
    const grantor = newCreditGrantor(100, 0.25);
    expect(grantor.consumed(25, false)).toBe(25);
  });
});
