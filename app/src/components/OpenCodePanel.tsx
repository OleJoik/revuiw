import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSetting } from "../hooks";
import { renderMarkdown, handleCopyClick } from "../markdown";
import {
  listSessions, createSession, getMessages, sendPrompt, selectionLabel,
  type Session, type Message, type Agent, type SelectionContext,
} from "../opencode";

interface Props {
  open: boolean;
  onToggle: () => void;
  focused: boolean;
  onFocus: () => void;
  pendingSelection: SelectionContext | null;
  onConsumeSelection: () => void;
  onSessionChange: (id: string | null) => void;
  activateSession: { id: string; token: number } | null;
}

export function OpenCodePanel({
  open, onToggle, focused, onFocus,
  pendingSelection, onConsumeSelection, onSessionChange, activateSession,
}: Props) {
  const [width, setWidth] = useSetting("oc:width", 340);
  const [agent, setAgent] = useSetting<Agent>("oc:agent", "plan");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<SelectionContext | null>(null);
  const [loading, setLoading] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);

  // Resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.max(240, Math.min(window.innerWidth * 0.5, window.innerWidth - e.clientX)));
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const selectSession = useCallback(async (session: Session) => {
    setCurrentSession(session);
    setMessages([]);
    const msgs = await getMessages(session.id);
    setMessages(msgs);
  }, []);

  // Load sessions when opened
  useEffect(() => {
    if (!open) return;
    listSessions().then(setSessions).catch(() => setSessions([]));
  }, [open]);

  // Report the active main-session id upward so popovers know what to fork
  useEffect(() => {
    onSessionChange(currentSession?.id ?? null);
  }, [currentSession, onSessionChange]);

  // Adopt a selection sent from the Viewer as an attached context chip
  useEffect(() => {
    if (!pendingSelection) return;
    setAttached(pendingSelection);
    onConsumeSelection();
    inputRef.current?.focus();
  }, [pendingSelection, onConsumeSelection]);

  // Switch to a session on external request (e.g. promoted from a popover)
  useEffect(() => {
    if (!activateSession) return;
    const existing = sessions.find(s => s.id === activateSession.id);
    selectSession(existing ?? { id: activateSession.id });
    listSessions().then(setSessions).catch(() => {});
  }, [activateSession?.token]);

  // Scroll to bottom
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Refocus input after loading completes
  useEffect(() => {
    if (!loading && focused) inputRef.current?.focus();
  }, [loading]);

  // Focus input when panel receives focus
  useEffect(() => {
    if (focused && open && !loading) inputRef.current?.focus();
  }, [focused]);

  const createNewSession = async (title?: string) => {
    const session = await createSession(title);
    if (!session) return null;
    setSessions(prev => [session, ...prev]);
    setCurrentSession(session);
    setMessages([]);
    return session;
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !attached) || loading) return;

    let session = currentSession;
    if (!session) {
      session = await createNewSession(text.slice(0, 50) || "revuiw session");
      if (!session) return;
    }

    const context = attached;
    setInput("");
    setAttached(null);
    setLoading(true);

    // Optimistic user message (note the attached context, if any)
    const userText = context ? `\`${selectionLabel(context)}\`\n${text}` : text;
    setMessages(prev => [...prev, { info: { role: "user" }, parts: [{ type: "text", text: userText }] }]);

    try {
      const reply = await sendPrompt({ sessionId: session.id, message: text, agent, context });
      setMessages(prev => [...prev, reply]);
    } catch (err: any) {
      setMessages(prev => [...prev, { info: { role: "error" }, parts: [{ type: "text", text: err.message }] }]);
    }

    setLoading(false);
  };

  // Collapsed state: just show tab
  if (!open) {
    return (
      <div className="oc-tab" onClick={onToggle} title="Open OpenCode">OC</div>
    );
  }

  const sorted = [...sessions].sort((a, b) => {
    return new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();
  });

  return (
    <div className={`oc-panel ${focused ? "panel-focused" : ""}`} style={{ width }} onMouseDown={onFocus}>
      <div className="resize-handle resize-handle-left" onMouseDown={startResize} />
      <div className="oc-header">
        <span>OpenCode</span>
        <button className="oc-close" onClick={onToggle}>&times;</button>
      </div>
      <div className="oc-sessions">
        <div className="oc-sessions-header">
          <span>Sessions</span>
          <button onClick={() => createNewSession()}>+ New</button>
        </div>
        <div className="oc-session-list">
          {sorted.length === 0 && <div className="oc-empty">No sessions</div>}
          {sorted.slice(0, 20).map(s => (
            <div
              key={s.id}
              className={`oc-session-item ${currentSession?.id === s.id ? "active" : ""}`}
              onClick={() => selectSession(s)}
            >
              {s.title || `Session ${s.id.slice(0, 8)}`}
            </div>
          ))}
        </div>
      </div>
      <div className="oc-chat">
        <div className="oc-messages" onClick={handleCopyClick}>
          {messages.length === 0 && <div className="oc-empty">Send a message to start</div>}
          {messages.map((msg, i) => {
            const role = msg.info?.role || "unknown";
            const text = (msg.parts || [])
              .filter(p => p.type === "text")
              .map(p => p.text)
              .join("");
            if (!text.trim()) return null;
            const isAssistant = role === "assistant";
            return (
              <div key={i} className={`oc-msg ${role}`}>
                {isAssistant ? (
                  <div
                    className="oc-markdown"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(text.trim()) }}
                  />
                ) : (
                  text.trim()
                )}
              </div>
            );
          })}
          {loading && <div className="oc-msg status">Thinking...</div>}
          <div ref={messagesEnd} />
        </div>
        {attached && (
          <div className="oc-chip-row">
            <span className="oc-chip" title={attached.path}>
              <span className="oc-chip-label">{selectionLabel(attached)}</span>
              <button className="oc-chip-remove" onClick={() => setAttached(null)} title="Remove context">&times;</button>
            </span>
          </div>
        )}
        <div className="oc-input-row">
          <div className="oc-agent-toggle" title="Plan = discuss only · Do = can edit files">
            <button className={agent === "plan" ? "active" : ""} onClick={() => setAgent("plan")}>Plan</button>
            <button className={agent === "build" ? "active" : ""} onClick={() => setAgent("build")}>Do</button>
          </div>
          <input
            ref={inputRef}
            type="text"
            placeholder={agent === "plan" ? "Discuss (no changes)..." : "Ask to make changes..."}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={loading}
          />
          <button onClick={send} disabled={loading || (!input.trim() && !attached)}>Send</button>
        </div>
      </div>
    </div>
  );
}
