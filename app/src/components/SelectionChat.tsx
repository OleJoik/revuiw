import React, { useState, useRef, useEffect, useCallback } from "react";
import { useSetting } from "../hooks";
import { renderMarkdown, handleCopyClick } from "../markdown";
import {
  forkSession, createSession, getMessages, sendPrompt, selectionLabel, threadContext,
  type Message, type Agent, type SelectionThread,
} from "../opencode";

interface Props {
  thread: SelectionThread;
  onClose: () => void;
  onRemove: () => void;
  onSessionCreated: (sessionId: string) => void;
  onPromote: (sessionId: string) => void;
}

function textParts(msg: Message): string[] {
  return (msg.parts || []).filter(p => p.type === "text").map(p => p.text || "");
}

function stripInjectedSelection(text: string): string {
  return text.replace(/^Selected from `[^`]+` \(lines \d+[–-]\d+\):\s*```[^\n]*\n[\s\S]*?\n```\s*/, "");
}

function displayText(msg: Message): string {
  const role = msg.info?.role || "unknown";
  const parts = textParts(msg);
  if (role !== "user") return parts.join("");
  if (parts.length > 1 && parts[0].startsWith("Selected from `")) return parts.slice(1).join("\n");
  return stripInjectedSelection(parts.join("\n"));
}

export function SelectionChat({ thread, onClose, onRemove, onSessionCreated, onPromote }: Props) {
  const [agent, setAgent] = useSetting<Agent>("oc:agent", "plan");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasSession, setHasSession] = useState(!!thread.sessionId);
  const sessionRef = useRef<string | null>(thread.sessionId);
  const [pos, setPos] = useState(() => thread.placement || { x: Math.max(60, window.innerWidth - 460), y: 90 });
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  useEffect(() => {
    if (thread.placement && !dragOffset.current) setPos(thread.placement);
  }, [thread.placement?.x, thread.placement?.y]);

  // Reload conversation history when (re)opening a thread that already has a session.
  useEffect(() => {
    sessionRef.current = thread.sessionId;
    setHasSession(!!thread.sessionId);
    if (thread.sessionId) {
      getMessages(thread.sessionId).then(setMessages).catch(() => {});
    }
  }, [thread.sessionId]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Keep the latest onClose so the listeners below can subscribe just once.
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Auto-close once focus / interaction leaves this popover entirely.
  useEffect(() => {
    const closeIfOutside = (target: EventTarget | null) => {
      if (target instanceof Node && rootRef.current && !rootRef.current.contains(target)) {
        onCloseRef.current();
      }
    };
    const onMouseDown = (e: MouseEvent) => closeIfOutside(e.target);
    const onFocusIn = (e: FocusEvent) => {
      // Ignore focus falling back to <body> (e.g. our input being disabled while
      // a message sends) — that's not the user navigating away.
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

  // Lazily fork (or create) the backing session on first message.
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionRef.current) return sessionRef.current;
    const s = thread.parentSessionId
      ? await forkSession(thread.parentSessionId)
      : await createSession(`selection: ${selectionLabel(thread)}`);
    if (!s) return null;
    sessionRef.current = s.id;
    setHasSession(true);
    onSessionCreated(s.id);
    return s.id;
  }, [thread, onSessionCreated]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    // Attach the selection only on the very first turn of this thread.
    const first = messages.length === 0 && !sessionRef.current;
    const sid = await ensureSession();
    if (!sid) {
      setMessages(prev => [...prev, { info: { role: "error" }, parts: [{ type: "text", text: "Could not start session" }] }]);
      return;
    }

    const ctx = first ? threadContext(thread) : null;
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

  return (
    <div ref={rootRef} className="sel-chat" style={{ left: pos.x, top: pos.y }} onKeyDown={handleKeyDown}>
      <div className="sel-chat-header" onMouseDown={startDrag}>
        <span className="sel-chat-title" title={thread.path}>{selectionLabel(thread)}</span>
        <div className="sel-chat-header-actions">
          <button
            className="sel-chat-btn"
            disabled={!hasSession}
            title={hasSession ? "Open this thread in the main panel" : "Send a message first"}
            onClick={() => sessionRef.current && onPromote(sessionRef.current)}
          >
            Promote
          </button>
          <button className="sel-chat-btn" title="Delete this anchor" onClick={onRemove}>Del</button>
          <button className="sel-chat-close" title="Close (keeps anchor in gutter)" onClick={onClose}>&times;</button>
        </div>
      </div>

      <div className="sel-chat-messages" onClick={handleCopyClick}>
        {messages.length === 0 && (
          <div className="oc-empty">
            {thread.parentSessionId ? "Forked from current session — ask about this selection" : "Ask about this selection"}
          </div>
        )}
        {messages.map((msg, i) => {
          const role = msg.info?.role || "unknown";
          const text = displayText(msg);
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
