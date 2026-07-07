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
  const [relNum, setRelNum] = useSetting("viewer:relnumber", false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineEls = useRef<HTMLElement[]>([]);
  const cursorRef = useRef(0);
  const relNumRef = useRef(relNum);
  relNumRef.current = relNum;

  const lineCount = tokens ? tokens.length : content.split("\n").length;
  const lineCountRef = useRef(lineCount);
  lineCountRef.current = lineCount;

  // Update line numbers in the DOM directly
  const updateLineNumbers = useCallback((cursor: number) => {
    const els = lineEls.current;
    const count = lineCountRef.current;
    const rel = relNumRef.current;
    for (let i = 0; i < count; i++) {
      const el = els[i];
      if (!el) continue;
      const numEl = el.firstElementChild as HTMLElement;
      if (!numEl) continue;
      numEl.textContent = rel
        ? (i === cursor ? String(i + 1) : String(Math.abs(i - cursor)))
        : String(i + 1);
    }
  }, []);

  // Move cursor via DOM manipulation (no re-render)
  const moveCursor = useCallback((next: number) => {
    const prev = cursorRef.current;
    if (next === prev) return;
    const oldEl = lineEls.current[prev];
    const newEl = lineEls.current[next];
    if (oldEl) oldEl.classList.remove("cursor-line");
    if (newEl) {
      newEl.classList.add("cursor-line");
      newEl.scrollIntoView({ block: "nearest" });
    }
    cursorRef.current = next;
    if (relNumRef.current) updateLineNumbers(next);
  }, [updateLineNumbers]);

  // Reset cursor when file changes
  useEffect(() => {
    cursorRef.current = 0;
  }, [filePath]);

  // Sync cursor-line class when focus changes
  useEffect(() => {
    const el = lineEls.current[cursorRef.current];
    if (!el) return;
    if (focused) {
      el.classList.add("cursor-line");
    } else {
      el.classList.remove("cursor-line");
    }
  }, [focused]);

  // Re-apply line numbers when relNum mode toggles
  useEffect(() => {
    updateLineNumbers(cursorRef.current);
  }, [relNum, updateLineNumbers]);

  // Vim-like keyboard navigation when viewer is focused
  useEffect(() => {
    if (!focused || !filePath || loading) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey) return;

      // Ctrl+d: half-page down
      if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        const body = bodyRef.current;
        if (!body) return;
        const pageLines = Math.floor(body.clientHeight / 18 / 2);
        moveCursor(Math.min(cursorRef.current + pageLines, lineCount - 1));
        return;
      }

      // Ctrl+u: half-page up
      if (e.ctrlKey && e.key === "u") {
        e.preventDefault();
        const body = bodyRef.current;
        if (!body) return;
        const pageLines = Math.floor(body.clientHeight / 18 / 2);
        moveCursor(Math.max(cursorRef.current - pageLines, 0));
        return;
      }

      if (e.ctrlKey) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          moveCursor(Math.min(cursorRef.current + 1, lineCount - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          moveCursor(Math.max(cursorRef.current - 1, 0));
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
          e.preventDefault();
          moveCursor(0);
          break;
        case "G":
          e.preventDefault();
          moveCursor(lineCount - 1);
          break;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [focused, filePath, loading, lineCount, moveCursor]);

  useEffect(() => {
    if (!filePath) { setContent(""); setTokens(null); return; }
    setLoading(true);
    setTokens(null);

    fetch(`/api/read?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(data => {
        setContent(data.content || "");
        setLoading(false);

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
    if (el) lineEls.current[i] = el;
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
            className={`viewer-wrap-toggle ${relNum ? "active" : ""}`}
            onClick={() => setRelNum(!relNum)}
            title={relNum ? "Absolute line numbers" : "Relative line numbers"}
          >
            Rel
          </button>
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
      <div className={`viewer-body ${wrap ? "wrap" : "nowrap"} ${relNum ? "rel-numbers" : ""}`} ref={bodyRef}>
        {loading ? (
          <div className="viewer-loading">Loading...</div>
        ) : tokens ? (
          <pre className="shiki"><code>{tokens.map((line, i) => (
            <span
              className="line"
              key={i}
              ref={(el) => setLineRef(i, el)}
              onMouseDown={() => moveCursor(i)}
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
              className="line"
              key={i}
              ref={(el) => setLineRef(i, el)}
              onMouseDown={() => moveCursor(i)}
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
