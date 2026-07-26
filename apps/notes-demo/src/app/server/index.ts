import type { FilesApi } from "@statewalker/webrun-files";
import { newNotesStore } from "./notes-store.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
  ValidationError,
} from "./usecases.ts";

/**
 * REST controller for the notes API. Runs under `newServerRunner`, which invokes
 * this default export with `(request, env)` where `env.data` is the workspace
 * `FilesApi`. Matches method + `/api/notes[/:id]` and maps use-case outcomes to
 * HTTP responses (200 / 201 / 204 / 400 / 404).
 */

interface ServerEnv {
  data: FilesApi;
}

const ROUTE = /^\/api\/notes(?:\/([^/]+))?\/?$/;

async function readBody(request: Request): Promise<{ title: string; body: string }> {
  const parsed = await request.json();
  if (typeof parsed !== "object" || parsed === null) throw new ValidationError("body must be JSON");
  const { title, body } = parsed as Record<string, unknown>;
  return { title: String(title ?? ""), body: typeof body === "string" ? body : "" };
}

export default async function handle(request: Request, env: ServerEnv): Promise<Response> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return new Response("Not Found", { status: 404 });

  const id = match[1];
  const store = newNotesStore(env.data);

  try {
    if (!id) {
      if (request.method === "GET") return Response.json(await listNotes(store));
      if (request.method === "POST") {
        const note = await createNote(store, await readBody(request));
        return Response.json(note, { status: 201 });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (request.method === "GET") {
      const note = await getNote(store, id);
      return note ? Response.json(note) : new Response("Not Found", { status: 404 });
    }
    if (request.method === "PUT") {
      const note = await updateNote(store, id, await readBody(request));
      return note ? Response.json(note) : new Response("Not Found", { status: 404 });
    }
    if (request.method === "DELETE") {
      await deleteNote(store, id);
      return new Response(null, { status: 204 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}
