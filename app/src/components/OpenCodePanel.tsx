import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSetting } from "../hooks";
import { renderMarkdown, handleCopyClick } from "../markdown";
import {
  listSessions, createSession, deleteSession, getMessages, sendPrompt, selectionLabel,
  listModels, switchModel,
  type Session, type Message, type Agent, type SelectionContext, type ModelInfo,
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
  onAfterPrompt?: () => void;
}

export function OpenCodePanel({
  open, onToggle, focused, onFocus,
  pendingSelection, onConsumeSelection, onSessionChange, activateSession, onAfterPrompt,
}: Props) {
  const [width, setWidth] = useSetting("oc:width", 340);
  const [agent, setAgent] = useSetting<Agent>("oc:agent", "plan");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<SelectionContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [verbose, setVerbose] = useSetting("oc:verbose", false);
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
      // Refresh sessions to pick up model info after first prompt
      listSessions().then(list => {
        setSessions(list);
        const updated = list.find(s => s.id === session.id);
        if (updated) setCurrentSession(updated);
      }).catch(() => {});
    } catch (err: any) {
      setMessages(prev => [...prev, { info: { role: "error" }, parts: [{ type: "text", text: err.message }] }]);
    }

    setLoading(false);
    onAfterPrompt?.();
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
        <span className="oc-header-session" onClick={() => { listSessions().then(setSessions).catch(() => {}); setShowSessions(!showSessions); setShowModelPicker(false); }} title="Switch session">
          <span className={`oc-chevron ${showSessions ? "open" : ""}`}>&#9656;</span>
          {currentSession?.title || "New conversation"}
        </span>
        {currentSession?.model && (
          <span
            className="oc-model-badge clickable"
            title={`${currentSession.model.providerID}/${currentSession.model.id} — click to change`}
            onClick={() => { listModels().then(setModels).catch(() => {}); setShowModelPicker(!showModelPicker); setShowSessions(false); }}
          >
            {currentSession.model.id}
          </span>
        )}
        {!currentSession?.model && (
          <span
            className="oc-model-badge clickable"
            title="Select model"
            onClick={() => { listModels().then(setModels).catch(() => {}); setShowModelPicker(!showModelPicker); setShowSessions(false); }}
          >
            model
          </span>
        )}
        <div className="oc-header-actions">
          <button className="oc-new-btn" onClick={() => { setCurrentSession(null); setMessages([]); setShowSessions(false); }} title="New session">+</button>
          <button className="oc-close" onClick={onToggle}>&times;</button>
        </div>
      </div>
      {showSessions && (
        <div className="oc-sessions">
          <div className="oc-session-list">
            {sorted.length === 0 && <div className="oc-empty">No sessions</div>}
            {sorted.slice(0, 20).map(s => (
              <div
                key={s.id}
                className={`oc-session-item ${currentSession?.id === s.id ? "active" : ""}`}
                onClick={() => { selectSession(s); setShowSessions(false); }}
              >
                <span className="oc-session-title">{s.title || `Session ${s.id.slice(0, 8)}`}</span>
                <button
                  className="oc-session-delete"
                  title="Delete session"
                  onClick={(e) => { e.stopPropagation(); deleteSession(s.id).then(ok => { if (ok) { setSessions(prev => prev.filter(x => x.id !== s.id)); if (currentSession?.id === s.id) { setCurrentSession(null); setMessages([]); } } }); }}
                >&times;</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {showModelPicker && (
        <div className="oc-model-picker">
          {models.length === 0 && <div className="oc-empty">No models available</div>}
          {models.map(m => (
            <div
              key={`${m.providerID}/${m.id}`}
              className={`oc-model-item ${currentSession?.model?.id === m.id && currentSession?.model?.providerID === m.providerID ? "active" : ""}`}
              onClick={async () => {
                let session = currentSession;
                if (!session) {
                  session = await createSession("revuiw session");
                  if (!session) return;
                  setSessions(prev => [session!, ...prev]);
                  setCurrentSession(session);
                }
                await switchModel(session.id, { id: m.id, providerID: m.providerID });
                setCurrentSession({ ...session, model: { id: m.id, providerID: m.providerID } });
                setShowModelPicker(false);
              }}
            >
              <span className="oc-model-item-name">{m.name || m.id}</span>
              <span className="oc-model-item-provider">{m.providerID}</span>
            </div>
          ))}
        </div>
      )}
      <div className="oc-chat">
        <div className="oc-messages" onClick={handleCopyClick}>
          {messages.length === 0 && <div className="oc-empty">Send a message to start</div>}
          {messages.map((msg, i) => {
            const role = msg.info?.role || "unknown";
            const parts = msg.parts || [];
            const textParts = parts.filter(p => p.type === "text").map(p => p.text).join("");
            const reasoningParts = verbose ? parts.filter(p => p.type === "reasoning").map(p => p.text).join("") : "";
            const toolParts = verbose ? parts.filter(p => p.type === "tool") : [];
            if (!textParts.trim() && !reasoningParts.trim() && toolParts.length === 0) return null;
            const isAssistant = role === "assistant";
            return (
              <div key={i} className={`oc-msg ${role}`}>
                {reasoningParts.trim() && (
                  <details className="oc-reasoning">
                    <summary>Thinking</summary>
                    <div className="oc-reasoning-text">{reasoningParts.trim()}</div>
                  </details>
                )}
                {toolParts.map((tp, j) => (
                  <details key={j} className="oc-tool-call">
                    <summary>{tp.state?.title || tp.tool || tp.toolName || "tool"}{tp.state?.status ? ` (${tp.state.status})` : ""}</summary>
                    {tp.state?.output && <pre className="oc-tool-output">{tp.state.output.slice(0, 500)}</pre>}
                  </details>
                ))}
                {textParts.trim() && (isAssistant ? (
                  <div
                    className="oc-markdown"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(textParts.trim()) }}
                  />
                ) : (
                  textParts.trim()
                ))}
              </div>
            );
          })}
          {loading && <div className="oc-msg status">Thinking...</div>}
          <div ref={messagesEnd} />
        </div>
        {attached && (
          <div className="oc-chip-row">
            <span className="oc-chip" title={attached.note ? `${attached.path}\n\nNote: ${attached.note}` : attached.path}>
              <span className="oc-chip-label">{selectionLabel(attached)}</span>
              {attached.note && <span className="oc-chip-note" title="Includes note comment">note</span>}
              <button className="oc-chip-remove" onClick={() => setAttached(null)} title="Remove context">&times;</button>
            </span>
          </div>
        )}
        <div className="oc-input-row">
          <div className="oc-agent-toggle" title="Plan = discuss only · Do = can edit files">
            <button className={agent === "plan" ? "active" : ""} onClick={() => setAgent("plan")}>Plan</button>
            <button className={agent === "build" ? "active" : ""} onClick={() => setAgent("build")}>Do</button>
          </div>
          <button
            className={`oc-verbose-toggle ${verbose ? "active" : ""}`}
            onClick={() => setVerbose(!verbose)}
            title={verbose ? "Hide thinking & tools" : "Show thinking & tools"}
          >{verbose ? "V" : "v"}</button>
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
