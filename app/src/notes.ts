// Notes: persistent code review annotations stored in .revuiw/notes/.
//
// A note is a human-created observation anchored to a single line in a file.
// It stores the original code snippet for context and has resolved/unresolved
// status. AI discussion happens via the main session — the note itself just
// records your thoughts.

export interface Note {
  id: string;
  file: string;        // relative path from project root
  anchorLine: number;  // 1-indexed
  anchorText: string;  // content of the anchor line (for fuzzy re-anchoring)
  originalSnippet: string; // the selected code block at creation time
  startLine: number;   // 1-indexed, start of original selection
  endLine: number;     // 1-indexed, end of original selection
  status: "unresolved" | "resolved";
  body: string;        // the human-written note content
  createdAt: string;   // ISO timestamp
  updatedAt: string;   // ISO timestamp
}

export type NoteCreate = Pick<Note, "file" | "anchorLine" | "anchorText" | "originalSnippet" | "startLine" | "endLine" | "body">;
export type NoteUpdate = Partial<Pick<Note, "body" | "status" | "anchorLine" | "anchorText">>;

const BASE = "/api/notes";

export async function listNotes(): Promise<Note[]> {
  const res = await fetch(BASE);
  return res.ok ? res.json() : [];
}

export async function createNote(data: NoteCreate): Promise<Note | null> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.ok ? res.json() : null;
}

export async function updateNote(id: string, data: NoteUpdate): Promise<Note | null> {
  const res = await fetch(`${BASE}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.ok ? res.json() : null;
}

export async function deleteNote(id: string): Promise<boolean> {
  const res = await fetch(`${BASE}/${id}`, { method: "DELETE" });
  return res.ok;
}

// Human-readable label for a note anchor, e.g. "Viewer.tsx:142".
export function noteLabel(note: Note): string {
  const name = note.file.split("/").pop() || note.file;
  return `${name}:${note.anchorLine}`;
}
