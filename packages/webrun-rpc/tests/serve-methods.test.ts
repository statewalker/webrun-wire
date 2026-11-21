import { afterEach, describe, expect, it } from "vitest";
import { callPort } from "../src/call-port.js";
import { methodsClient, serveMethods } from "../src/serve-methods.js";

interface Store {
  put(key: string, data: Uint8Array): Promise<{ key: string; size: number }>;
  get(key: string): Promise<Uint8Array | undefined>;
  fail(code?: string): Promise<void>;
}

const METHODS = ["put", "get", "fail"] as const;
const channelName = "test/store";

function newStore(): Store & { secret(): string } {
  const data = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      data.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      return data.get(key);
    },
    async fail(code) {
      const error = new Error("it failed") as Error & { code?: string };
      if (code) error.code = code;
      throw error;
    },
    secret() {
      return "not served";
    },
  };
}

const open: MessagePort[] = [];
function channel(): { a: MessagePort; b: MessagePort } {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  return { a: port1, b: port2 };
}
afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

describe("serveMethods / methodsClient", () => {
  it("calls the served object's methods and carries Uint8Array both ways", async () => {
    const { a, b } = channel();
    const stop = serveMethods(b, newStore(), { channelName, methods: METHODS });
    const store = methodsClient<Store>(a, { channelName, methods: METHODS });

    const put = await store.put("k", new Uint8Array([1, 2, 3]));
    expect(put).toEqual({ key: "k", size: 3 });
    const got = await store.get("k");
    expect(got).toBeInstanceOf(Uint8Array);
    expect([...(got as Uint8Array)]).toEqual([1, 2, 3]);
    stop();
  });

  it.each(["secret", "toString", "constructor", "__proto__", "hasOwnProperty"])(
    "refuses a call to '%s', which is not among the served methods",
    async (method) => {
      const { a, b } = channel();
      const stop = serveMethods(b, newStore(), { channelName, methods: METHODS });
      const call = callPort(a, { method, args: [] }, { channelName });
      await expect(call).rejects.toMatchObject({ code: "ENOSYS" });
      await expect(call).rejects.toThrow(method);
      stop();
    },
  );

  it("refuses a call whose arguments are not an array", async () => {
    const { a, b } = channel();
    const stop = serveMethods(b, newStore(), { channelName, methods: METHODS });
    const call = callPort(a, { method: "get", args: "k" }, { channelName });
    await expect(call).rejects.toMatchObject({ code: "EINVAL" });
    stop();
  });

  it("refuses a listed method the object does not have", async () => {
    const { a, b } = channel();
    const stop = serveMethods(b, {} as Store, { channelName, methods: METHODS });
    const store = methodsClient<Store>(a, { channelName, methods: METHODS });
    await expect(store.get("k")).rejects.toMatchObject({ code: "ENOSYS" });
    stop();
  });

  it("rejects with the thrown error's message and code", async () => {
    const { a, b } = channel();
    const stop = serveMethods(b, newStore(), { channelName, methods: METHODS });
    const store = methodsClient<Store>(a, { channelName, methods: METHODS });
    const error = await store.fail("EBUSY").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "it failed", code: "EBUSY" });
    const plain = await store.fail().catch((e: unknown) => e);
    expect(plain).toMatchObject({ message: "it failed" });
    expect((plain as { code?: unknown }).code).toBeUndefined();
    stop();
  });

  it("does not send the server's stack or other properties of the error", async () => {
    const { a, b } = channel();
    const impl = {
      async leak(): Promise<void> {
        throw Object.assign(new Error("denied"), { code: "EACCES", path: "/secret/key" });
      },
    };
    const stop = serveMethods(b, impl, { channelName, methods: ["leak"] });
    const client = methodsClient<typeof impl>(a, { channelName, methods: ["leak"] });
    const error = (await client.leak().catch((e: unknown) => e)) as Error & Record<string, unknown>;
    expect(error).toMatchObject({ message: "denied", code: "EACCES" });
    expect(error.path).toBeUndefined();
    expect(error.stack ?? "").not.toContain("leak");
    stop();
  });

  it("carries a thrown non-Error as its message", async () => {
    const { a, b } = channel();
    const impl = {
      async odd(): Promise<void> {
        throw "plain string";
      },
    };
    const stop = serveMethods(b, impl, { channelName, methods: ["odd"] });
    const client = methodsClient<typeof impl>(a, { channelName, methods: ["odd"] });
    await expect(client.odd()).rejects.toThrow("plain string");
    stop();
  });

  it("answers ETIMEDOUT when a method runs past the server's timeout", async () => {
    const { a, b } = channel();
    const impl = { hang: (): Promise<void> => new Promise(() => {}) };
    const stop = serveMethods(b, impl, { channelName, methods: ["hang"], timeout: 20 });
    const client = methodsClient<typeof impl>(a, { channelName, methods: ["hang"], timeout: 5000 });
    await expect(client.hang()).rejects.toMatchObject({ code: "ETIMEDOUT" });
    stop();
  });

  it("rejects a call with no answer within the client's timeout", async () => {
    const { a } = channel();
    const client = methodsClient<Store>(a, { channelName, methods: METHODS, timeout: 20 });
    await expect(client.get("k")).rejects.toThrow(/timeout/i);
  });
});
