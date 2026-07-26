import type { Note } from "./frontmatter.ts";
import type { NotesStore } from "./notes-store.ts";

/**
 * The five note operations, each doing real work (validation, id + timestamp
 * assignment) over a `NotesStore`. Missing-id outcomes are reported as
 * `undefined` / `false`; invalid input throws `ValidationError`.
 */

export interface NoteInput {
  title: string;
  body: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** Thrown when input fails validation (mapped to HTTP 400 by the controller). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function validate(input: NoteInput): void {
  if (typeof input?.title !== "string" || input.title.trim() === "") {
    throw new ValidationError("title is required");
  }
}

export async function listNotes(store: NotesStore): Promise<NoteSummary[]> {
  const notes = await store.list();
  return notes.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
}

export async function getNote(store: NotesStore, id: string): Promise<Note | undefined> {
  return store.read(id);
}

export async function createNote(store: NotesStore, input: NoteInput): Promise<Note> {
  validate(input);
  const now = new Date().toISOString();
  const note: Note = {
    id: crypto.randomUUID(),
    title: input.title,
    body: input.body ?? "",
    createdAt: now,
    updatedAt: now,
  };
  await store.save(note);
  return note;
}

export async function updateNote(
  store: NotesStore,
  id: string,
  input: NoteInput,
): Promise<Note | undefined> {
  validate(input);
  const existing = await store.read(id);
  if (!existing) return undefined;
  const note: Note = {
    ...existing,
    title: input.title,
    body: input.body ?? "",
    updatedAt: new Date().toISOString(),
  };
  await store.save(note);
  return note;
}

export async function deleteNote(store: NotesStore, id: string): Promise<boolean> {
  return store.remove(id);
}
