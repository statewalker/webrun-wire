import { marked } from "marked";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// Client served under `~/client/`; the API lives at the site root `/api`, two
// levels up from the client document.
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
  const [error, setError] = useState("");

  async function refresh(): Promise<void> {
    try {
      setNotes(await listNotes());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Mount-only initial load; kept self-contained so it needs no unstable deps.
  useEffect(() => {
    listNotes()
      .then(setNotes)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function open(id: string): Promise<void> {
    try {
      const note = await readNote(id);
      setCurrent(note);
      setTitle(note.title);
      setBody(note.body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function createNew(): Promise<void> {
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
    setError("");
  }

  async function save(): Promise<void> {
    if (!current) return;
    const res = await fetch(`${API}/${encodeURIComponent(current.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    if (res.ok) {
      setCurrent(await res.json());
      setError("");
      await refresh();
    } else {
      setError(`Save failed (${res.status}) — a title is required.`);
    }
  }

  async function remove(): Promise<void> {
    if (!current) return;
    await fetch(`${API}/${encodeURIComponent(current.id)}`, { method: "DELETE" });
    setCurrent(undefined);
    setTitle("");
    setBody("");
    await refresh();
  }

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
        <div className="editor">
          {error ? <p className="error">{error}</p> : null}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write markdown…"
          />
          <div className="toolbar">
            <button type="button" id="save-note" onClick={() => void save()}>
              Save
            </button>
            <button type="button" id="delete-note" onClick={() => void remove()}>
              Delete
            </button>
          </div>
          <div
            className="preview"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: demo markdown preview
            dangerouslySetInnerHTML={{ __html: marked.parse(body, { async: false }) as string }}
          />
        </div>
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
