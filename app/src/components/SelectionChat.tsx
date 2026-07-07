import React, { useState, useRef, useEffect, useCallback } from "react";
import { useSetting } from "../hooks";
import { renderMarkdown, handleCopyClick } from "../markdown";
import {
  forkSession, createSession, sendPrompt, selectionLabel,
  type Message, type Agent, type SelectionContext,
} from "../opencode";

interface Props {
  context: SelectionContext;
  parentSessionId: string | null;
  onClose: () => void;
  onPromote: (sessionId: string) => void;
}

// Offset each new popover so stacked ones don't perfectly overlap.
let spawnCount = 0;

export function SelectionChat({ context, parentSessionId, onClose, onPromote }: Props) {
  const [agent, setAgent] = useSetting<Agent>("oc:agent", "plan");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState(() => {
    const n = spawnCount++;
    return { x: Math.max(60, window.innerWidth - 460 - (n % 4) * 28), y: 90 + (n % 4) * 28 };
  });
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Dragging by the header
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

  // Lazily fork (or create) the backing session on first use.
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    const s = parentSessionId
      ? await forkSession(parentSessionId)
      : await createSession(`selection: ${selectionLabel(context)}`);
    if (!s) return null;
    setSessionId(s.id);
    return s.id;
  }, [sessionId, parentSessionId, context]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const sid = await ensureSession();
    if (!sid) {
      setMessages(prev => [...prev, { info: { role: "error" }, parts: [{ type: "text", text: "Could not start session" }] }]);
      return;
    }

    // Attach the selection only on the first turn of this thread.
    const ctx = messages.length === 0 ? context : null;
    setInput("");
    setLoading(true);
    setMessages(prev => [...prev, { info: { role: "user" }, parts: [{ type: "text", text }] }]);

    try {
      const reply = await sendPrompt({ sessionId: sid, message: text, agent, context: ctx });
      setMessages(prev => [...prev, reply]);
    } catch (err: any) {
      setMessages(prev => [...prev, { info: { role: "error" }, parts: [{ type: "text", text: err.message }] }]);
    }
    setLoading(false);
    inputRef.current?.focus();
  };

  const preview = context.text.split("\n").slice(0, 6).join("\n");
  const truncated = context.text.split("\n").length > 6;

  return (
    <div className="sel-chat" style={{ left: pos.x, top: pos.y }}>
      <div className="sel-chat-header" onMouseDown={startDrag}>
        <span className="sel-chat-title" title={context.path}>{selectionLabel(context)}</span>
        <div className="sel-chat-header-actions">
          <button
            className="sel-chat-promote"
            disabled={!sessionId}
            title={sessionId ? "Open this thread in the main panel" : "Send a message first"}
            onClick={() => sessionId && onPromote(sessionId)}
          >
            Promote
          </button>
          <button className="sel-chat-close" onClick={onClose}>&times;</button>
        </div>
      </div>

      <pre className="sel-chat-context">{preview}{truncated ? "\n…" : ""}</pre>

      <div className="sel-chat-messages" onClick={handleCopyClick}>
        {messages.length === 0 && (
          <div className="oc-empty">
            {parentSessionId ? "Forked from current session — ask about this selection" : "Ask about this selection"}
          </div>
        )}
        {messages.map((msg, i) => {
          const role = msg.info?.role || "unknown";
          const text = (msg.parts || []).filter(p => p.type === "text").map(p => p.text).join("");
          if (!text.trim()) return null;
          const isAssistant = role === "assistant";
          return (
            <div key={i} className={`oc-msg ${role}`}>
              {isAssistant
                ? <div className="oc-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text.trim()) }} />
                : text.trim()}
            </div>
          );
        })}
        {loading && <div className="oc-msg status">Thinking...</div>}
        <div ref={messagesEnd} />
      </div>

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
        <button onClick={send} disabled={loading || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
