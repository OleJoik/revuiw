import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSetting } from "../hooks";

interface Props {
  filePath: string | null;
  onClose: () => void;
  focused: boolean;
  onFocus: () => void;
}

export function Viewer({ filePath, onClose, focused, onFocus }: Props) {
  const [content, setContent] = useState<string>("");
  const [tokens, setTokens] = useState<any[][] | null>(null);
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useSetting("viewer:wrap", false);
  const [cursorLine, setCursorLine] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());

  const lineCount = tokens ? tokens.length : content.split("\n").length;

  // Reset cursor when file changes
  useEffect(() => {
    setCursorLine(0);
  }, [filePath]);

  // Scroll cursor line into view
  const scrollToLine = useCallback((line: number) => {
    const el = lineRefs.current.get(line);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, []);

  // Vim-like keyboard navigation when viewer is focused
  useEffect(() => {
    if (!focused || !filePath || loading) return;

    const handleKey = (e: KeyboardEvent) => {
      // Don't capture if a modifier other than ctrl is held (allow browser shortcuts)
      if (e.altKey || e.metaKey) return;

      // Ctrl+d: half-page down
      if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        const body = bodyRef.current;
        if (!body) return;
        const pageLines = Math.floor(body.clientHeight / 18 / 2); // ~18px per line, half page
        setCursorLine(prev => {
          const next = Math.min(prev + pageLines, lineCount - 1);
          setTimeout(() => scrollToLine(next), 0);
          return next;
        });
        return;
      }

      // Ctrl+u: half-page up
      if (e.ctrlKey && e.key === "u") {
        e.preventDefault();
        const body = bodyRef.current;
        if (!body) return;
        const pageLines = Math.floor(body.clientHeight / 18 / 2);
        setCursorLine(prev => {
          const next = Math.max(prev - pageLines, 0);
          setTimeout(() => scrollToLine(next), 0);
          return next;
        });
        return;
      }

      // Only handle plain keys (no ctrl) for hjkl
      if (e.ctrlKey) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setCursorLine(prev => {
            const next = Math.min(prev + 1, lineCount - 1);
            setTimeout(() => scrollToLine(next), 0);
            return next;
          });
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setCursorLine(prev => {
            const next = Math.max(prev - 1, 0);
            setTimeout(() => scrollToLine(next), 0);
            return next;
          });
          break;
        case "h":
        case "ArrowLeft":
          e.preventDefault();
          if (bodyRef.current) {
            bodyRef.current.scrollLeft = Math.max(0, bodyRef.current.scrollLeft - 40);
          }
          break;
        case "l":
        case "ArrowRight":
          e.preventDefault();
          if (bodyRef.current) {
            bodyRef.current.scrollLeft += 40;
          }
          break;
        case "g":
          // gg: go to top (simplified: single g goes to top)
          e.preventDefault();
          setCursorLine(0);
          setTimeout(() => scrollToLine(0), 0);
          break;
        case "G":
          // G: go to bottom
          e.preventDefault();
          const last = lineCount - 1;
          setCursorLine(last);
          setTimeout(() => scrollToLine(last), 0);
          break;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [focused, filePath, loading, lineCount, scrollToLine]);

  useEffect(() => {
    if (!filePath) { setContent(""); setTokens(null); return; }
    setLoading(true);
    setTokens(null);

    fetch(`/api/read?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(data => {
        setContent(data.content || "");
        setLoading(false);

        // Fetch highlighted tokens in background
        if (data.lang) {
          fetch(`/api/highlight?path=${encodeURIComponent(filePath)}`)
            .then(r => r.json())
            .then(hl => { if (hl.tokens) setTokens(hl.tokens); })
            .catch(() => {});
        }
      })
      .catch(() => { setContent("Error reading file"); setLoading(false); });
  }, [filePath]);

  const setLineRef = useCallback((i: number, el: HTMLElement | null) => {
    if (el) lineRefs.current.set(i, el);
    else lineRefs.current.delete(i);
  }, []);

  if (!filePath) {
    return (
      <div className={`viewer ${focused ? "panel-focused" : ""}`} onMouseDown={onFocus}>
        <div className="viewer-placeholder">Select a file to view its contents</div>
      </div>
    );
  }

  const plainLines = !tokens ? content.split("\n") : null;

  return (
    <div className={`viewer ${focused ? "panel-focused" : ""}`} onMouseDown={onFocus}>
      <div className="viewer-header">
        <span className="viewer-path">{filePath}</span>
        <div className="viewer-actions">
          <button
            className={`viewer-wrap-toggle ${wrap ? "active" : ""}`}
            onClick={() => setWrap(!wrap)}
            title={wrap ? "Disable word wrap" : "Enable word wrap"}
          >
            Wrap
          </button>
          <button className="viewer-close" onClick={onClose}>&times;</button>
        </div>
      </div>
      <div className={`viewer-body ${wrap ? "wrap" : "nowrap"}`} ref={bodyRef}>
        {loading ? (
          <div className="viewer-loading">Loading...</div>
        ) : tokens ? (
          <pre className="shiki"><code>{tokens.map((line, i) => (
            <span
              className={`line ${focused && i === cursorLine ? "cursor-line" : ""}`}
              key={i}
              ref={(el) => setLineRef(i, el)}
            >
              <span className="line-number">{i + 1}</span>
              {line.map((t: any, j: number) => (
                <span key={j} style={{ color: t.color }}>{t.content}</span>
              ))}
            </span>
          ))}</code></pre>
        ) : (
          <pre><code>{plainLines!.map((line, i) => (
            <span
              className={`line ${focused && i === cursorLine ? "cursor-line" : ""}`}
              key={i}
              ref={(el) => setLineRef(i, el)}
            >
              <span className="line-number">{i + 1}</span>
              {line}
            </span>
          ))}</code></pre>
        )}
      </div>
    </div>
  );
}
