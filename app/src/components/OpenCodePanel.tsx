import React, { useState, useEffect, useRef, useCallback } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useSetting } from "../hooks";

// Configure marked for safe, compact output
marked.setOptions({
  breaks: true,
  gfm: true,
});

// DOMPurify config matching OpenCode's web UI
const purifyConfig: DOMPurify.Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_ATTR: ["target"],
};

function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string;
  const clean = DOMPurify.sanitize(raw, purifyConfig);
  // Wrap <pre> blocks with a container for copy button
  return clean.replace(
    /<pre>([\s\S]*?)<\/pre>/g,
    '<div class="oc-code-wrap"><pre>$1</pre><button class="oc-copy-btn" type="button">Copy</button></div>'
  );
}

interface Props {
  open: boolean;
  onToggle: () => void;
}

interface Session {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  toolName?: string;
}

interface Message {
  info?: { role?: string };
  parts?: MessagePart[];
}

export function OpenCodePanel({ open, onToggle }: Props) {
  const [width, setWidth] = useSetting("oc:width", 340);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
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

  // Load sessions
  useEffect(() => {
    if (!open) return;
    fetch("/api/opencode/sessions")
      .then(r => r.ok ? r.json() : [])
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [open]);

  // Scroll to bottom
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Refocus input after loading completes
  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  // Delegated click handler for copy buttons in rendered markdown
  const handleMessagesClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("oc-copy-btn")) return;
    const wrap = target.closest(".oc-code-wrap");
    const code = wrap?.querySelector("code");
    if (!code) return;
    navigator.clipboard.writeText(code.textContent || "");
    target.textContent = "Copied";
    setTimeout(() => { target.textContent = "Copy"; }, 1500);
  }, []);

  const selectSession = async (session: Session) => {
    setCurrentSession(session);
    setMessages([]);
    try {
      const res = await fetch(`/api/opencode/sessions/${session.id}/messages`);
      if (res.ok) setMessages(await res.json());
    } catch {}
  };

  const createSession = async (title?: string) => {
    const res = await fetch("/api/opencode/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title || "revuiw session" }),
    });
    if (!res.ok) return null;
    const session = await res.json();
    setSessions(prev => [session, ...prev]);
    setCurrentSession(session);
    setMessages([]);
    return session;
  };

  const sendPrompt = async () => {
    const text = input.trim();
    if (!text || loading) return;

    let session = currentSession;
    if (!session) {
      session = await createSession(text.slice(0, 50));
      if (!session) return;
    }

    setInput("");
    setLoading(true);

    // Optimistic user message
    setMessages(prev => [...prev, { info: { role: "user" }, parts: [{ type: "text", text }] }]);

    try {
      const res = await fetch(`/api/opencode/sessions/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setMessages(prev => [...prev, { info: { role: "assistant" }, parts: data.parts || [] }]);
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
    <div className="oc-panel" style={{ width }}>
      <div className="resize-handle resize-handle-left" onMouseDown={startResize} />
      <div className="oc-header">
        <span>OpenCode</span>
        <button className="oc-close" onClick={onToggle}>&times;</button>
      </div>
      <div className="oc-sessions">
        <div className="oc-sessions-header">
          <span>Sessions</span>
          <button onClick={() => createSession()}>+ New</button>
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
        <div className="oc-messages" onClick={handleMessagesClick}>
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
        <div className="oc-input-row">
          <input
            ref={inputRef}
            type="text"
            placeholder="Ask a question..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); } }}
            disabled={loading}
          />
          <button onClick={sendPrompt} disabled={loading || !input.trim()}>Send</button>
        </div>
      </div>
    </div>
  );
}
