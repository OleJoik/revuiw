import React, { useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { Viewer, type Placement, type MarkReviewArgs } from "./components/Viewer";
import { OpenCodePanel } from "./components/OpenCodePanel";
import { NotePopover } from "./components/NotePopover";
import { useSetting } from "./hooks";
import { listNotes, createNote, type Note, type NoteCreate } from "./notes";
import { getReview, markReview, type ReviewState } from "./review";
import type { Panel } from "./types";
import type { SelectionContext } from "./opencode";

export function App() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useSetting("sidebar:open", true);
  const [ocOpen, setOcOpen] = useSetting("oc:open", false);
  const [focusedPanel, setFocusedPanel] = useState<Panel>("viewer");

  // Notes state
  const [notes, setNotes] = useState<Note[]>([]);
  const [openNoteIds, setOpenNoteIds] = useState<string[]>([]);
  const [notePlacements, setNotePlacements] = useState<Map<string, Placement>>(new Map());

  // Review state for the currently-open file, plus refresh tokens.
  const [review, setReview] = useState<ReviewState | null>(null);
  const [reloadToken, setReloadToken] = useState(0);   // re-read file content (after agent edits)
  const [reviewVersion, setReviewVersion] = useState(0); // refresh sidebar review summary

  // Selection -> chat wiring (flow A: main panel).
  const [pendingSelection, setPendingSelection] = useState<SelectionContext | null>(null);
  const [mainSessionId, setMainSessionId] = useState<string | null>(null);
  const [activateSession, setActivateSession] = useState<{ id: string; token: number } | null>(null);

  // Load notes from server on mount
  useEffect(() => {
    listNotes().then(setNotes).catch(() => {});
  }, []);

  // Reset the review overlay immediately on file change so the viewer shows a
  // loading state (rather than the previous file's rows) until the fetch lands.
  useEffect(() => { setReview(null); }, [selectedFile]);

  // Load review state whenever the file changes or content is reloaded. On a
  // pure reload (same file) we keep the current rows visible until the new ones
  // arrive, avoiding a scroll-losing flash after agent edits.
  useEffect(() => {
    if (!selectedFile) { setReview(null); return; }
    let cancelled = false;
    getReview(selectedFile).then(r => { if (!cancelled) setReview(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedFile, reloadToken]);

  const onMarkReviewed = useCallback(async (args: MarkReviewArgs) => {
    if (!selectedFile) return;
    const next = await markReview({ path: selectedFile, ...args });
    if (next) setReview(next);
    setReviewVersion(v => v + 1);
  }, [selectedFile]);

  // Called after a chat prompt completes: the agent may have edited files, so
  // re-read the viewer content (which re-derives the review overlay) and
  // refresh the sidebar summary.
  const onAfterPrompt = useCallback(() => {
    setReloadToken(t => t + 1);
    setReviewVersion(v => v + 1);
  }, []);

  const openChat = useCallback(() => {
    setOcOpen(true);
    setFocusedPanel("chat");
  }, [setOcOpen]);

  const sendSelectionToChat = useCallback((ctx: SelectionContext) => {
    setPendingSelection(ctx);
    openChat();
  }, [openChat]);

  // Create a new note from a code selection (flow B: press C)
  const createNoteFromSelection = useCallback(async (ctx: SelectionContext, placement?: Placement) => {
    const lines = ctx.text.split("\n");
    const anchorLine = ctx.startLine;
    const anchorText = lines[0] || "";
    const data: NoteCreate = {
      file: ctx.path,
      anchorLine,
      anchorText,
      originalSnippet: ctx.text,
      startLine: ctx.startLine,
      endLine: ctx.endLine,
      body: "",
    };
    const note = await createNote(data);
    if (note) {
      setNotes(prev => [...prev, note]);
      setOpenNoteIds(prev => [...prev, note.id]);
      if (placement) {
        setNotePlacements(prev => new Map(prev).set(note.id, placement));
      }
    }
  }, []);

  const closeNote = useCallback((id: string) => {
    setOpenNoteIds(prev => prev.filter(x => x !== id));
  }, []);

  const toggleNote = useCallback((id: string, placement?: Placement) => {
    setOpenNoteIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (placement) setNotePlacements(p => new Map(p).set(id, placement));
      return [...prev, id];
    });
  }, []);

  const removeNote = useCallback((id: string) => {
    setOpenNoteIds(prev => prev.filter(x => x !== id));
    setNotes(prev => prev.filter(n => n.id !== id));
  }, []);

  const handleNoteUpdated = useCallback((updated: Note) => {
    setNotes(prev => prev.map(n => n.id === updated.id ? updated : n));
  }, []);

  // Pick a note into the main chat context: attach its code snippet plus the
  // human-written comment. Fast path for "discuss this later with the agent"
  // without spinning up a per-note conversation.
  const pickNoteToChat = useCallback((note: Note) => {
    const ctx: SelectionContext = {
      path: note.file,
      startLine: note.startLine,
      endLine: note.endLine,
      text: note.originalSnippet,
      note: note.body || undefined,
    };
    setPendingSelection(ctx);
    openChat();
  }, [openChat]);

  // Get ordered list of visible panels
  const getVisiblePanels = useCallback((): Panel[] => {
    const panels: Panel[] = [];
    if (sidebarOpen) panels.push("sidebar");
    panels.push("viewer");
    if (ocOpen) panels.push("chat");
    return panels;
  }, [sidebarOpen, ocOpen]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "e") {
        e.preventDefault();
        if (sidebarOpen && focusedPanel === "sidebar") {
          setSidebarOpen(false);
        } else {
          if (!sidebarOpen) setSidebarOpen(true);
          setFocusedPanel("sidebar");
        }
        return;
      }

      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (ocOpen && focusedPanel === "chat") {
          setOcOpen(false);
        } else {
          if (!ocOpen) setOcOpen(true);
          setFocusedPanel("chat");
        }
        return;
      }

      if (e.ctrlKey && (e.key === "h" || e.key === "ArrowLeft")) {
        e.preventDefault();
        const panels = getVisiblePanels();
        const idx = panels.indexOf(focusedPanel);
        if (idx > 0) setFocusedPanel(panels[idx - 1]);
        return;
      }

      if (e.ctrlKey && (e.key === "l" || e.key === "ArrowRight")) {
        e.preventDefault();
        const panels = getVisiblePanels();
        const idx = panels.indexOf(focusedPanel);
        if (idx < panels.length - 1) setFocusedPanel(panels[idx + 1]);
        return;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [focusedPanel, sidebarOpen, ocOpen, getVisiblePanels]);

  // If focused panel gets closed, move focus to viewer
  useEffect(() => {
    if (focusedPanel === "sidebar" && !sidebarOpen) setFocusedPanel("viewer");
    if (focusedPanel === "chat" && !ocOpen) setFocusedPanel("viewer");
  }, [sidebarOpen, ocOpen]);

  // Build anchors for the Viewer from notes on the current file
  const anchors = notes
    .filter(n => n.file === selectedFile)
    .map(n => ({
      id: n.id,
      startLine: n.startLine,
      endLine: n.endLine,
      open: openNoteIds.includes(n.id),
      status: n.status,
    }));

  // Compute set of files with unresolved notes for the sidebar
  const filesWithNotes = new Set(
    notes.filter(n => n.status === "unresolved").map(n => n.file)
  );

  return (
    <div className="app-layout">
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onSelectFile={(path) => { setSelectedFile(path); setFocusedPanel("viewer"); }}
        focused={focusedPanel === "sidebar"}
        onFocus={() => setFocusedPanel("sidebar")}
        filesWithNotes={filesWithNotes}
        reviewVersion={reviewVersion}
      />
      <Viewer
        filePath={selectedFile}
        onClose={() => setSelectedFile(null)}
        focused={focusedPanel === "viewer"}
        onFocus={() => setFocusedPanel("viewer")}
        onSendToChat={sendSelectionToChat}
        onCreateNote={createNoteFromSelection}
        anchors={anchors}
        onAnchorClick={toggleNote}
        review={review}
        onMarkReviewed={onMarkReviewed}
        reloadToken={reloadToken}
      />
      <OpenCodePanel
        open={ocOpen}
        onToggle={() => setOcOpen(!ocOpen)}
        focused={focusedPanel === "chat"}
        onFocus={() => setFocusedPanel("chat")}
        pendingSelection={pendingSelection}
        onConsumeSelection={() => setPendingSelection(null)}
        onSessionChange={setMainSessionId}
        activateSession={activateSession}
        onAfterPrompt={onAfterPrompt}
      />
      {notes.filter(n => openNoteIds.includes(n.id)).map(n => (
        <NotePopover
          key={n.id}
          note={n}
          placement={notePlacements.get(n.id)}
          onClose={() => closeNote(n.id)}
          onRemove={() => removeNote(n.id)}
          onUpdated={handleNoteUpdated}
          onPickToChat={pickNoteToChat}
        />
      ))}
    </div>
  );
}
