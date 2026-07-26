import debounce from "lodash.debounce";
import { marked } from "marked";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// Client served under `/~/client/`; the REST API lives at the site root `/api`,
// two levels up from the client document.
const API = "../../api/notes";

interface NoteSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface Note extends NoteSummary {
  body: string;
  createdAt: string;
}

async function listNotes(): Promise<NoteSummary[]> {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Failed to list notes (${res.status})`);
  return res.json();
}

async function readNote(id: string): Promise<Note> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to open note (${res.status})`);
  return res.json();
}

function App(): JSX.Element {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [current, setCurrent] = useState<Note | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  async function refresh(): Promise<void> {
    try {
      setNotes(await listNotes());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // One debounced writer for the whole editor: the latest title+body are passed
  // as args (so it never reads stale state), and it persists ~600ms after the
  // last keystroke. Created once; cancelled on note-switch, delete, and unmount.
  const autosave = useMemo(
    () =>
      debounce(async (id: string, t: string, b: string) => {
        const res = await fetch(`${API}/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: t, body: b }),
        });
        if (res.ok) {
          setCurrent(await res.json());
          setStatus("Saved");
          try {
            setNotes(await listNotes());
          } catch {
            /* keep the current list on a transient refresh failure */
          }
        } else {
          setStatus(`Save failed (${res.status}) — a title is required.`);
        }
      }, 600),
    [],
  );
  useEffect(() => () => autosave.cancel(), [autosave]);

  // A single edit entry point: updates state and schedules an auto-save.
  function edit(nextTitle: string, nextBody: string): void {
    setTitle(nextTitle);
    setBody(nextBody);
    if (current) {
      setStatus("Saving…");
      autosave(current.id, nextTitle, nextBody);
    }
  }

  async function open(id: string): Promise<void> {
    autosave.cancel();
    try {
      const note = await readNote(id);
      setCurrent(note);
      setTitle(note.title);
      setBody(note.body);
      setStatus("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function createNew(): Promise<void> {
    autosave.cancel();
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Untitled", body: "" }),
    });
    const note: Note = await res.json();
    await refresh();
    setCurrent(note);
    setTitle(note.title);
    setBody(note.body);
    setStatus("");
    setError("");
  }

  async function remove(): Promise<void> {
    if (!current) return;
    autosave.cancel();
    await fetch(`${API}/${encodeURIComponent(current.id)}`, { method: "DELETE" });
    setCurrent(undefined);
    setTitle("");
    setBody("");
    setStatus("");
    await refresh();
  }

  // Mount-only initial load; kept self-contained so it needs no unstable deps.
  useEffect(() => {
    listNotes()
      .then(setNotes)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="app">
      <div className="sidebar">
        <header>
          <button type="button" id="new-note" onClick={() => void createNew()}>
            + New
          </button>
        </header>
        <ul className="list">
          {notes.map((n) => (
            <li key={n.id} className={current?.id === n.id ? "active" : ""}>
              <button type="button" className="row" onClick={() => void open(n.id)}>
                <span className="title">{n.title || "Untitled"}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {current ? (
        <>
          {/* Column 2: the editor for the selected note. */}
          <div className="editor">
            {error ? <p className="error">{error}</p> : null}
            <input value={title} onChange={(e) => edit(e.target.value, body)} placeholder="Title" />
            <textarea
              value={body}
              onChange={(e) => edit(title, e.target.value)}
              placeholder="Write markdown…"
            />
            <div className="toolbar">
              <span className="status">{status}</span>
              <button type="button" id="delete-note" onClick={() => dialogRef.current?.showModal()}>
                Delete
              </button>
            </div>
          </div>
          {/* Column 3: the rendered preview of the current note. */}
          <div
            className="preview"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: demo markdown preview
            dangerouslySetInnerHTML={{ __html: marked.parse(body, { async: false }) as string }}
          />
          <dialog ref={dialogRef} className="confirm">
            <p>Delete this note?</p>
            <div className="dialog-actions">
              <button
                type="button"
                id="confirm-delete"
                onClick={() => {
                  dialogRef.current?.close();
                  void remove();
                }}
              >
                Delete
              </button>
              <button type="button" onClick={() => dialogRef.current?.close()}>
                Cancel
              </button>
            </div>
          </dialog>
        </>
      ) : (
        <p className="empty">Select a note or create a new one.</p>
      )}
    </div>
  );
}

const root = document.getElementById("app");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
