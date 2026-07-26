import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import handler from "../src/app/server/index.ts";

function env() {
  return { data: new MemFilesApi(), params: {} };
}

function call(
  e: ReturnType<typeof env>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return handler(new Request(`http://site.local${path}`, init), e);
}

describe("notes controller", () => {
  it("runs the full CRUD lifecycle with correct status codes and JSON shapes", async () => {
    const e = env();

    const created = await call(e, "POST", "/api/notes", { title: "A", body: "hello" });
    expect(created.status).toBe(201);
    const note = await created.json();
    expect(note).toMatchObject({ title: "A", body: "hello" });
    expect(note.id).toBeTruthy();
    expect(note.createdAt).toBe(note.updatedAt);

    const listed = await call(e, "GET", "/api/notes");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([{ id: note.id, title: "A", updatedAt: note.updatedAt }]);

    const read = await call(e, "GET", `/api/notes/${note.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: note.id, body: "hello" });

    const updated = await call(e, "PUT", `/api/notes/${note.id}`, { title: "B", body: "world" });
    expect(updated.status).toBe(200);
    const after = await updated.json();
    expect(after.title).toBe("B");
    expect(after.body).toBe("world");
    expect(after.createdAt).toBe(note.createdAt);

    const deleted = await call(e, "DELETE", `/api/notes/${note.id}`);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");

    const gone = await call(e, "GET", `/api/notes/${note.id}`);
    expect(gone.status).toBe(404);
  });

  it("rejects a missing title with 400 and writes nothing", async () => {
    const e = env();
    const res = await call(e, "POST", "/api/notes", { body: "no title" });
    expect(res.status).toBe(400);
    const listed = await call(e, "GET", "/api/notes");
    expect(await listed.json()).toEqual([]);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const e = env();
    const res = await handler(
      new Request("http://site.local/api/notes", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
      e,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for reading/updating an unknown id", async () => {
    const e = env();
    expect((await call(e, "GET", "/api/notes/nope")).status).toBe(404);
    expect((await call(e, "PUT", "/api/notes/nope", { title: "x", body: "y" })).status).toBe(404);
  });
});
