import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSetting } from "../hooks";

interface Props {
  filePath: string | null;
  onClose: () => void;
  focused: boolean;
  onFocus: () => void;
}

function HScrollbar({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [thumb, setThumb] = useState({ left: 0, width: 0, visible: false });
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartScroll = useRef(0);

  const update = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { scrollWidth, clientWidth, scrollLeft } = el;
    if (scrollWidth <= clientWidth) {
      setThumb({ left: 0, width: 0, visible: false });
      return;
    }
    const ratio = clientWidth / scrollWidth;
    const thumbWidth = Math.max(ratio * 100, 10);
    const thumbLeft = (scrollLeft / (scrollWidth - clientWidth)) * (100 - thumbWidth);
    setThumb({ left: thumbLeft, width: thumbWidth, visible: true });
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Also observe the pre inside for content size changes
    const pre = el.querySelector("pre");
    if (pre) ro.observe(pre);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [containerRef, update]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartScroll.current = containerRef.current?.scrollLeft || 0;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current || !trackRef.current) return;
      const trackWidth = trackRef.current.clientWidth;
      const { scrollWidth, clientWidth } = containerRef.current;
      const dx = ev.clientX - dragStartX.current;
      const scrollRange = scrollWidth - clientWidth;
      const thumbRange = trackWidth - (thumb.width / 100) * trackWidth;
      containerRef.current.scrollLeft = dragStartScroll.current + (dx / thumbRange) * scrollRange;
    };

    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [containerRef, thumb.width]);

  const onTrackClick = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clickRatio = (e.clientX - rect.left) / rect.width;
    const { scrollWidth, clientWidth } = containerRef.current;
    containerRef.current.scrollLeft = clickRatio * (scrollWidth - clientWidth);
  }, [containerRef]);

  if (!thumb.visible) return null;

  return (
    <div className="viewer-hscroll-track" ref={trackRef} onMouseDown={onTrackClick}>
      <div
        className="viewer-hscroll-thumb"
        style={{ left: `${thumb.left}%`, width: `${thumb.width}%` }}
        onMouseDown={onMouseDown}
      />
    </div>
  );
}

export function Viewer({ filePath, onClose, focused, onFocus }: Props) {
  const [content, setContent] = useState<string>("");
  const [tokens, setTokens] = useState<any[][] | null>(null);
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useSetting("viewer:wrap", false);
  const [relNum, setRelNum] = useSetting("viewer:relnumber", false);
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

  const getLineNumber = useCallback((i: number) => {
    if (!relNum) return i + 1;
    // Relative: cursor line shows absolute, others show distance
    if (i === cursorLine) return i + 1;
    return Math.abs(i - cursorLine);
  }, [relNum, cursorLine]);

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
              className={`line ${focused && i === cursorLine ? "cursor-line" : ""}`}
              key={i}
              ref={(el) => setLineRef(i, el)}
            >
              <span className="line-number">{getLineNumber(i)}</span>
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
              <span className="line-number">{getLineNumber(i)}</span>
              {line}
            </span>
          ))}</code></pre>
        )}
      </div>
      <HScrollbar containerRef={bodyRef} />
    </div>
  );
}
