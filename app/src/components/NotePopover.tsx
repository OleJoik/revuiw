import React, { useState, useRef, useEffect, useCallback } from "react";
import { updateNote, deleteNote, noteLabel, type Note } from "../notes";

interface Props {
  note: Note;
  onClose: () => void;
  onRemove: () => void;
  onUpdated: (note: Note) => void;
  onDiscuss: (note: Note) => void;
}

export function NotePopover({ note, onClose, onRemove, onUpdated, onDiscuss }: Props) {
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const [showSnippet, setShowSnippet] = useState(false);
  const [pos, setPos] = useState(() => ({ x: Math.max(60, window.innerWidth - 460), y: 90 }));
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const bodyDirty = body !== note.body;

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { setBody(note.body); }, [note.body]);
  useEffect(() => { textareaRef.current?.focus(); }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  // Auto-close on outside click/focus
  useEffect(() => {
    const closeIfOutside = (target: EventTarget | null) => {
      if (target instanceof Node && rootRef.current && !rootRef.current.contains(target)) {
        onCloseRef.current();
      }
    };
    const onMouseDown = (e: MouseEvent) => closeIfOutside(e.target);
    const onFocusIn = (e: FocusEvent) => {
      if (e.target === document.body || e.target === document.documentElement) return;
      closeIfOutside(e.target);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  // Dragging
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragOffset.current) return;
      setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
    };
    const onUp = () => { dragOffset.current = null; document.body.style.userSelect = ""; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    document.body.style.userSelect = "none";
  };

  const saveBody = useCallback(async () => {
    if (!bodyDirty || saving) return;
    setSaving(true);
    const updated = await updateNote(note.id, { body });
    if (updated) onUpdated(updated);
    setSaving(false);
  }, [note.id, body, bodyDirty, saving, onUpdated]);

  const toggleResolved = useCallback(async () => {
    const newStatus = note.status === "resolved" ? "unresolved" : "resolved";
    const updated = await updateNote(note.id, { status: newStatus });
    if (updated) onUpdated(updated);
  }, [note.id, note.status, onUpdated]);

  const handleDelete = useCallback(async () => {
    const ok = await deleteNote(note.id);
    if (ok) onRemove();
  }, [note.id, onRemove]);

  const handleDiscuss = useCallback(() => {
    // Save pending changes first
    if (bodyDirty) {
      updateNote(note.id, { body }).then(updated => {
        if (updated) onUpdated(updated);
      });
    }
    onDiscuss(note);
  }, [note, body, bodyDirty, onDiscuss, onUpdated]);

  return (
    <div ref={rootRef} className="note-popover" style={{ left: pos.x, top: pos.y }} onKeyDown={handleKeyDown}>
      <div className="note-popover-header" onMouseDown={startDrag}>
        <span className="note-popover-title" title={note.file}>
          {noteLabel(note)}
          <span className={`note-status-badge ${note.status}`}>{note.status}</span>
        </span>
        <div className="note-popover-actions">
          <button className="note-btn" title="Delete note" onClick={handleDelete}>Del</button>
          <button className="note-close" title="Close" onClick={onClose}>&times;</button>
        </div>
      </div>

      {/* Original snippet (collapsible) */}
      <div className="note-snippet-section">
        <button className="note-snippet-toggle" onClick={() => setShowSnippet(!showSnippet)}>
          {showSnippet ? "\u25BE" : "\u25B8"} Original snippet (lines {note.startLine}\u2013{note.endLine})
        </button>
        {showSnippet && (
          <pre className="note-snippet-code">{note.originalSnippet}</pre>
        )}
      </div>

      {/* Editable body */}
      <div className="note-body-section">
        <textarea
          ref={textareaRef}
          className="note-body-textarea"
          placeholder="Write your note..."
          value={body}
          onChange={e => setBody(e.target.value)}
          onBlur={saveBody}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              saveBody();
            }
          }}
        />
        {bodyDirty && <span className="note-unsaved-indicator">unsaved</span>}
      </div>

      {/* Actions */}
      <div className="note-actions-row">
        <button className="note-btn note-btn-discuss" onClick={handleDiscuss}>
          Discuss
        </button>
        <button
          className={`note-btn note-btn-resolve ${note.status === "resolved" ? "resolved" : ""}`}
          onClick={toggleResolved}
        >
          {note.status === "resolved" ? "Unresolve" : "Resolve"}
        </button>
      </div>
    </div>
  );
}
