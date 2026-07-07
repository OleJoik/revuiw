import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSetting } from "../hooks";

interface Props {
  filePath: string | null;
  onClose: () => void;
  focused: boolean;
  onFocus: () => void;
}

const LINE_HEIGHT = 18; // 12px font * 1.5 line-height
const PRE_PAD_TOP = 12; // padding-top on <pre>

export function Viewer({ filePath, onClose, focused, onFocus }: Props) {
  const [content, setContent] = useState<string>("");
  const [tokens, setTokens] = useState<any[][] | null>(null);
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useSetting("viewer:wrap", false);
  const [relNum, setRelNum] = useSetting("viewer:relnumber", false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cursorElRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const cursorRef = useRef(0);
  const relNumRef = useRef(relNum);
  relNumRef.current = relNum;

  const lineCount = tokens ? tokens.length : content.split("\n").length;
  const lineCountRef = useRef(lineCount);
  lineCountRef.current = lineCount;

  // Build gutter text — single string, one DOM write
  const updateGutter = useCallback((cursor: number) => {
    const el = gutterRef.current;
    if (!el) return;
    const count = lineCountRef.current;
    const rel = relNumRef.current;
    let text = "";
    for (let i = 0; i < count; i++) {
      if (i > 0) text += "\n";
      text += rel
        ? (i === cursor ? String(i + 1) : String(Math.abs(i - cursor)))
        : String(i + 1);
    }
    el.textContent = text;
  }, []);

  // Position the cursor overlay
  const positionCursor = useCallback((line: number) => {
    const el = cursorElRef.current;
    if (el) {
      el.style.transform = `translateY(${PRE_PAD_TOP + line * LINE_HEIGHT}px)`;
    }
  }, []);

  // Ensure cursor line is visible in the scroll viewport
  const ensureVisible = useCallback((line: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const elTop = PRE_PAD_TOP + line * LINE_HEIGHT;
    const elBottom = elTop + LINE_HEIGHT;
    const { scrollTop, clientHeight } = body;

    if (elTop < scrollTop) {
      body.scrollTop = elTop;
    } else if (elBottom > scrollTop + clientHeight) {
      body.scrollTop = elBottom - clientHeight;
    }
  }, []);

  // Move cursor
  const moveCursor = useCallback((next: number) => {
    const count = lineCountRef.current;
    if (next < 0) next = 0;
    if (next >= count) next = count - 1;
    if (next === cursorRef.current) return;
    cursorRef.current = next;
    positionCursor(next);
    ensureVisible(next);
    if (relNumRef.current) updateGutter(next);
  }, [positionCursor, ensureVisible, updateGutter]);

  // Initial gutter render
  useEffect(() => {
    cursorRef.current = 0;
    positionCursor(0);
    updateGutter(0);
  }, [filePath, tokens, content, positionCursor, updateGutter]);

  // Show/hide cursor overlay when focus changes
  useEffect(() => {
    const el = cursorElRef.current;
    if (el) {
      el.style.opacity = focused ? "1" : "0";
    }
  }, [focused]);

  // Re-apply gutter when relNum mode toggles
  useEffect(() => {
    updateGutter(cursorRef.current);
  }, [relNum, updateGutter]);

  // Vim-like keyboard navigation
  useEffect(() => {
    if (!focused || !filePath || loading) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey) return;

      if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        const body = bodyRef.current;
        if (!body) return;
        const half = Math.floor(body.clientHeight / LINE_HEIGHT / 2);
        moveCursor(cursorRef.current + half);
        return;
      }

      if (e.ctrlKey && e.key === "u") {
        e.preventDefault();
        const body = bodyRef.current;
        if (!body) return;
        const half = Math.floor(body.clientHeight / LINE_HEIGHT / 2);
        moveCursor(cursorRef.current - half);
        return;
      }

      if (e.ctrlKey) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          moveCursor(cursorRef.current + 1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          moveCursor(cursorRef.current - 1);
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
          moveCursor(lineCountRef.current - 1);
          break;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [focused, filePath, loading, moveCursor]);

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

  // Click to move cursor
  const handleLineClick = useCallback((e: React.MouseEvent) => {
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const y = e.clientY - rect.top + body.scrollTop - PRE_PAD_TOP;
    const line = Math.floor(y / LINE_HEIGHT);
    if (line >= 0 && line < lineCountRef.current) {
      cursorRef.current = line;
      positionCursor(line);
      if (relNumRef.current) updateGutter(line);
    }
  }, [positionCursor, updateGutter]);

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
      <div
        className={`viewer-body ${wrap ? "wrap" : "nowrap"} ${relNum ? "rel-numbers" : ""}`}
        ref={bodyRef}
        onMouseDown={handleLineClick}
      >
        <div className="viewer-cursor" ref={cursorElRef} />
        <pre className="viewer-gutter" ref={gutterRef} />
        {loading ? (
          <div className="viewer-loading">Loading...</div>
        ) : tokens ? (
          <pre className="shiki viewer-code"><code>{tokens.map((line, i) => (
            <span className="line" key={i}>
              {line.map((t: any, j: number) => (
                <span key={j} style={{ color: t.color }}>{t.content}</span>
              ))}
            </span>
          ))}</code></pre>
        ) : (
          <pre className="viewer-code"><code>{plainLines!.map((line, i) => (
            <span className="line" key={i}>{line}</span>
          ))}</code></pre>
        )}
      </div>
    </div>
  );
}
