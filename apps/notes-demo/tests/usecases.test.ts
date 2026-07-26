import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newNotesStore } from "../src/app/server/notes-store.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
  ValidationError,
} from "../src/app/server/usecases.ts";

const store = () => newNotesStore(new MemFilesApi());

afterEach(() => {
  vi.useRealTimers();
});

describe("usecases", () => {
  it("create assigns an id and equal created/updated timestamps", async () => {
    const s = store();
    const note = await createNote(s, { title: "First", body: "hi" });
    expect(note.id).toBeTruthy();
    expect(note.createdAt).toBe(note.updatedAt);
    expect(await getNote(s, note.id)).toEqual(note);
  });

  it("create with no title is rejected (nothing written)", async () => {
    const s = store();
    await expect(createNote(s, { title: "", body: "x" })).rejects.toBeInstanceOf(ValidationError);
    expect(await listNotes(s)).toEqual([]);
  });

  it("update preserves createdAt and advances updatedAt", async () => {
    const s = store();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const created = await createNote(s, { title: "T", body: "a" });

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const updated = await updateNote(s, created.id, { title: "T2", body: "b" });

    expect(updated).toBeDefined();
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(updated?.title).toBe("T2");
    expect(updated?.body).toBe("b");
  });

  it("update of a missing id is reported (undefined), not silently created", async () => {
    const s = store();
    expect(await updateNote(s, "nope", { title: "x", body: "y" })).toBeUndefined();
    expect(await listNotes(s)).toEqual([]);
  });

  it("delete of a missing id is reported (false)", async () => {
    const s = store();
    expect(await deleteNote(s, "nope")).toBe(false);
  });

  it("list returns id/title/updatedAt summaries", async () => {
    const s = store();
    const a = await createNote(s, { title: "A", body: "1" });
    const summaries = await listNotes(s);
    expect(summaries).toEqual([{ id: a.id, title: "A", updatedAt: a.updatedAt }]);
  });
});
