/**
 * A Chromium driven over raw CDP, attached to its pages only.
 *
 * Playwright attaches DevTools to every ServiceWorker, and a worker with
 * DevTools attached is never stopped for being idle: under Playwright the
 * ~30 s idle timeout never fires. Tests of what happens when it does (the
 * keep-alive, a long response body) need a browser whose ServiceWorkers live
 * as they would for a user. This one launches Chromium itself and speaks CDP
 * to the page targets it creates, and to nothing else.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export interface RawPage {
  /** Evaluates `expression` in the page, awaiting a promise, and returns the value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  close(): Promise<void>;
}

export interface RawChromium {
  newPage(url: string): Promise<RawPage>;
  close(): Promise<void>;
}

export async function launchRawChromium(): Promise<RawChromium> {
  const profile = mkdtempSync(join(tmpdir(), "raw-chromium-"));
  const child: ChildProcess = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Chromium did not start:\n${output}`)), 20_000);
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${output}`)));
  });

  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP connection failed"));
  });
  let nextId = 0;
  const pending = new Map<number, Pending>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  };
  const send = <T>(method: string, params: object = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  return {
    async newPage(url) {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      return {
        async evaluate<T>(expression: string) {
          const { result, exceptionDetails } = await send<{
            result: { value?: T };
            exceptionDetails?: { text: string; exception?: { description?: string } };
          }>(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            sessionId,
          );
          if (exceptionDetails) {
            throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
          }
          return result.value as T;
        },
        async close() {
          await send("Target.closeTarget", { targetId });
        },
      };
    },
    async close() {
      ws.close();
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
