/**
 * The rule: a credential is never persisted.
 *
 * The header's NAME is configuration and is saved; the header's VALUE lives in
 * memory and is merged per request. That distinction cannot be left to
 * callers, because getting it wrong is silent and permanent: a bearer key in
 * `localStorage` survives a reload, a shared machine, and anyone who opens
 * devtools.
 *
 * An earlier shape of this API stored a whole `Route`, and building the proxy
 * page on it would have done exactly that. So `StoredRoute` has no field a
 * value fits in, and `save()` THROWS rather than dropping one quietly — a
 * silent drop means a route that worked before the reload and 401s after it,
 * which is a worse afternoon than an exception.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileRouteStore } from "../src/node.js";
import {
  assertNoSecrets,
  rehydrate,
  SecretNotPersistableError,
  type StoredRoute,
  toStoredRoute,
} from "../src/store.js";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "webrun-proxy-routes-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const OPENAI: StoredRoute = {
  prefix: "/openai",
  upstream: "https://api.openai.com/v1",
  describe: "OpenAI",
  secretHeader: "authorization",
};

describe("a credential is never persisted", () => {
  it("refuses a route carrying a value, naming which route", () => {
    const leaky = { ...OPENAI, secret: "sk-live-do-not-write-me" };
    expect(() => assertNoSecrets([leaky as StoredRoute])).toThrow(SecretNotPersistableError);
    expect(() => assertNoSecrets([leaky as StoredRoute])).toThrow(/\/openai/);
  });

  it("refuses a whole headers bag — the likely mistake", () => {
    // Passing a live `Route` through by accident is the realistic path to a
    // leak, not somebody typing `secret:`.
    const withHeaders = { ...OPENAI, headers: { authorization: "Bearer sk-live" } };
    expect(() => assertNoSecrets([withHeaders as StoredRoute])).toThrow(SecretNotPersistableError);
  });

  it("accepts a route that carries only the header NAME", () => {
    expect(() => assertNoSecrets([OPENAI])).not.toThrow();
  });

  it("the file store refuses too, and writes nothing when it does", async () => {
    const dir = scratch();
    const store = fileRouteStore(join(dir, "routes.json"));

    await expect(
      store.save([{ ...OPENAI, secret: "sk-live" } as StoredRoute]),
    ).rejects.toThrow(SecretNotPersistableError);

    // Nothing was written, so a later load still says NEVER WRITTEN rather
    // than handing back a half-saved table.
    expect(await store.load()).toBeUndefined();
  });

  it("toStoredRoute keeps only the persistable fields", () => {
    const stored = toStoredRoute({
      ...OPENAI,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately extra.
      ...({ secret: "sk-live", upstreamHandler: () => {} } as any),
    });
    expect(stored).toEqual(OPENAI);
    expect(Object.keys(stored).sort()).toEqual(["describe", "prefix", "secretHeader", "upstream"]);
  });
});

describe("never written is not the same as empty", () => {
  it("load() returns undefined before anything is saved", async () => {
    const store = fileRouteStore(join(scratch(), "routes.json"));
    expect(await store.load()).toBeUndefined();
  });

  it("load() returns [] after the operator deletes every route", async () => {
    // The distinction a user can see: a first visit seeds demo routes, and a
    // visit after deleting them all must not bring them back.
    const store = fileRouteStore(join(scratch(), "routes.json"));
    await store.save([OPENAI]);
    await store.save([]);
    expect(await store.load()).toEqual([]);
  });

  it("round-trips a saved table", async () => {
    const store = fileRouteStore(join(scratch(), "routes.json"));
    await store.save([OPENAI]);
    expect(await store.load()).toEqual([OPENAI]);
  });
});

describe("rehydrate", () => {
  it("puts the secret back from memory, where it always was", () => {
    const inMemory = new Map([["/openai", "sk-live-from-memory"]]);
    const routes = rehydrate([OPENAI], {
      upstreamFor: (stored) => {
        const value = inMemory.get(stored.prefix);
        return async () =>
          new Response(null, {
            headers: stored.secretHeader && value ? { [stored.secretHeader]: value } : {},
          });
      },
    });

    expect(routes).toHaveLength(1);
    expect(routes[0]?.prefix).toBe("/openai");
    expect(routes[0]?.describe).toBe("OpenAI");
  });
});
