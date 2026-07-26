import type { FilesApi } from "@statewalker/webrun-files";
import { type Note, parseNote, serializeNote } from "./frontmatter.ts";

/**
 * CRUD over notes persisted as `/data/notes/<id>.md` in the injected `FilesApi`.
 * The store exposes no public `exists` method — callers use `read() === undefined`
 * (internally it still probes `FilesApi.exists` to distinguish a missing file).
 * Uses only the `FilesApi` surface (no npm helper): the server payload's sole
 * job is to demonstrate local relative resolution, so it carries no npm deps.
 */

const DIR = "/data/notes";
const pathFor = (id: string) => `${DIR}/${id}.md`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  if (!(await files.exists(path))) return undefined;
  let text = "";
  for await (const chunk of files.read(path)) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

export function newNotesStore(files: FilesApi) {
  return {
    async list(): Promise<Note[]> {
      const notes: Note[] = [];
      for await (const info of files.list(DIR)) {
        if (info.kind !== "file" || !info.name.endsWith(".md")) continue;
        const id = info.name.slice(0, -".md".length);
        const text = await readText(files, pathFor(id));
        if (text !== undefined) notes.push(parseNote(id, text));
      }
      // FilesApi.list order is backend-dependent; sort newest-first for a stable
      // UI (ISO timestamps sort lexicographically; id breaks same-ms ties).
      return notes.sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
    },

    async read(id: string): Promise<Note | undefined> {
      const text = await readText(files, pathFor(id));
      return text === undefined ? undefined : parseNote(id, text);
    },

    async save(note: Note): Promise<void> {
      await files.write(pathFor(note.id), [encoder.encode(serializeNote(note))]);
    },

    async remove(id: string): Promise<boolean> {
      return files.remove(pathFor(id));
    },
  };
}

export type NotesStore = ReturnType<typeof newNotesStore>;
