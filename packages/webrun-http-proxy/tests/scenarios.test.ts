/**
 * The twelve scenarios, in Node.
 *
 * They are the evidence that "reverse proxy" and "expose a local service" are
 * ONE mechanism, and they moved here with the code rather than being rewritten:
 * a scenario list that changes when it moves proves nothing about the move.
 *
 * The prototype also ran them in Chromium, which is what established that the
 * two upstream kinds behave identically on both platforms and that exactly one
 * row cannot pass in a browser (`Via` is a forbidden header name under the
 * Fetch spec — a fact about the platform, not this code). That second column
 * needs a bundler and a browser; it belongs to the extraction's browser
 * harness, and until it exists this file is the Node column alone and says so.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, startFixture } from "./fixture-server.js";
import { type Outcome, runScenarios } from "./scenarios.js";

describe("one route table, two upstream kinds", () => {
  let fixture: Fixture;
  let outcomes: Outcome[];

  beforeAll(async () => {
    fixture = await startFixture();
    outcomes = await runScenarios(fixture.origin);
    const rows = outcomes.map((o) => `  ${o.pass ? "✓" : "✗"}  ${o.name}${o.pass ? "" : ` — ${o.detail}`}`);
    console.log(`\nNode column:\n${rows.join("\n")}\n`);
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("runs every scenario", () => {
    // Guards the guard: an empty list would make the check below vacuous.
    expect(outcomes.length).toBeGreaterThanOrEqual(11);
  });

  it("passes all of them", () => {
    expect(outcomes.filter((o) => !o.pass).map((o) => `${o.name}: ${o.detail}`)).toEqual([]);
  });
});
