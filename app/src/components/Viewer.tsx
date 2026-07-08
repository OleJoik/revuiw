import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layout, prepare } from "@chenglou/pretext";
import { useSetting } from "../hooks";
import type { SelectionContext } from "../opencode";

export interface Placement {
  x: number;
  y: number;
}

interface Anchor {
  id: string;
  startLine: number;
  endLine: number;
  open: boolean;
  status?: "unresolved" | "resolved";
}

interface Props {
  filePath: string | null;
  onClose: () => void;
  focused: boolean;
  onFocus: () => void;
  onSendToChat: (ctx: SelectionContext) => void;
  onCreateNote: (ctx: SelectionContext, placement?: Placement) => void;
  anchors?: Anchor[];
  onAnchorClick?: (id: string, placement?: Placement) => void;
}

type Token = { content: string; color?: string };
type RowMetric = { top: number; height: number };

const LINE_HEIGHT = 18; // 12px font * 1.5 line-height
const PRE_PAD_TOP = 12;
const PRE_PAD_BOTTOM = 12;
const LINE_NUMBER_WIDTH = 9 * 7.2; // 9ch at 12px monospace, used only for wrap-width math.
const CODE_PAD_LEFT = LINE_NUMBER_WIDTH;
const CODE_PAD_RIGHT = 16;
const TAB_SIZE = 2;
const OVERSCAN_PX = 600;
const POPOVER_WIDTH = 400;
const POPOVER_ESTIMATED_HEIGHT = 300;
const POPOVER_GAP = 8;
const SCROLL_OFF_OPTIONS = [0, 3, 5, 8, 12];
const ANCHOR_LANE_STEP = 7; // px between overlapping gutter markers
const MAX_ANCHOR_LANES = 3; // cap so lanes never march into the line numbers

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampLine(line: number, count: number) {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, line));
}

function expandTabs(line: string) {
  let column = 0;
  let out = "";

  for (const char of line) {
    if (char === "\t") {
      const spaces = TAB_SIZE - (column % TAB_SIZE);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += char;
      column += 1;
    }
  }

  return out;
}

function buildFixedMetrics(count: number): RowMetric[] {
  return Array.from({ length: count }, (_, i) => ({
    top: PRE_PAD_TOP + i * LINE_HEIGHT,
    height: LINE_HEIGHT,
  }));
}

function buildWrappedMetrics(lines: string[], width: number, font: string): RowMetric[] {
  let top = PRE_PAD_TOP;

  return lines.map(line => {
    const prepared = prepare(expandTabs(line), font, { whiteSpace: "pre-wrap" });
    const measured = layout(prepared, width, LINE_HEIGHT);
    const height = Math.max(1, measured.lineCount) * LINE_HEIGHT;
    const metric = { top, height };
    top += height;
    return metric;
  });
}

function totalHeight(metrics: RowMetric[]) {
  const last = metrics[metrics.length - 1];
  return last ? last.top + last.height + PRE_PAD_BOTTOM : PRE_PAD_TOP + PRE_PAD_BOTTOM;
}

function clampScrollTop(value: number, metrics: RowMetric[], viewportHeight: number) {
  const maxScrollTop = Math.max(0, totalHeight(metrics) - viewportHeight);
  return Math.max(0, Math.min(maxScrollTop, value));
}

function findLineAtOffset(metrics: RowMetric[], y: number) {
  if (metrics.length === 0) return 0;
  const last = metrics[metrics.length - 1];
  if (y <= metrics[0].top) return 0;
  if (y >= last.top + last.height) return metrics.length - 1;

  let lo = 0;
  let hi = metrics.length - 1;
  let answer = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (metrics[mid].top + metrics[mid].height <= y) {
      lo = mid + 1;
    } else {
      answer = mid;
      hi = mid - 1;
    }
  }

  return answer;
}

function visibleRange(metrics: RowMetric[], scrollTop: number, viewportHeight: number) {
  if (metrics.length === 0) return { start: 0, end: 0 };

  const start = findLineAtOffset(metrics, Math.max(0, scrollTop - OVERSCAN_PX));
  const end = Math.max(start + 1, Math.min(
    metrics.length,
    findLineAtOffset(metrics, scrollTop + viewportHeight + OVERSCAN_PX) + 1,
  ));

  return { start, end };
}

function renderTokenLine(line: Token[]) {
  return line.map((token, i) => (
    <span key={i} style={token.color ? { color: token.color } : undefined}>
      {token.content}
    </span>
  ));
}

function renderLine(tokens: Token[][] | null, plainLines: string[], i: number) {
  const tokenLine = tokens?.[i];
  return tokenLine ? renderTokenLine(tokenLine) : plainLines[i];
}

function splitLines(content: string) {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function nextScrollOff(value: number) {
  const next = SCROLL_OFF_OPTIONS.find(option => option > value);
  return next ?? SCROLL_OFF_OPTIONS[0];
}

export function Viewer({ filePath, onClose, focused, onFocus, onSendToChat, onCreateNote, anchors = [], onAnchorClick }: Props) {
  const [content, setContent] = useState("");
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useSetting("viewer:wrap", false);
  const [relNum, setRelNum] = useSetting("viewer:relnumber", false);
  const [scrollOff, setScrollOff] = useSetting("viewer:scrolloff", 5);
  const [cursorLine, setCursorLine] = useState(0);
  const [visualAnchor, setVisualAnchor] = useState<number | null>(null);
  const [anchorStackIndex, setAnchorStackIndex] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0, width: 0 });
  const bodyRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(0);
  const countRef = useRef("");
  const cursorMapRef = useRef<Map<string, number>>(new Map());
  const prevFileRef = useRef<string | null>(null);

  const plainLines = useMemo(() => splitLines(content), [content]);
  const lines = plainLines;
  const lineCount = lines.length;
  const maxLineLength = useMemo(() => Math.max(1, ...lines.map(line => expandTabs(line).length)), [lines]);
  const wrapWidth = Math.max(1, viewport.width - CODE_PAD_LEFT - CODE_PAD_RIGHT);

  const metrics = useMemo(() => {
    if (!wrap) return buildFixedMetrics(lineCount);
    return buildWrappedMetrics(lines, wrapWidth, "12px JetBrains Mono, Fira Code, Cascadia Code, SF Mono, Consolas, monospace");
  }, [lineCount, lines, wrap, wrapWidth]);

  const range = useMemo(
    () => visibleRange(metrics, viewport.scrollTop, viewport.height),
    [metrics, viewport.height, viewport.scrollTop],
  );

  const height = totalHeight(metrics);
  const cursorMetric = metrics[cursorLine];

  const ensureVisible = useCallback((line: number) => {
    const body = bodyRef.current;
    const metric = metrics[line];
    if (!body || !metric) return;

    const setScrollTop = (value: number) => {
      body.scrollTop = clampScrollTop(value, metrics, body.clientHeight);
    };

    const topLine = Math.max(0, line - scrollOff);
    const bottomLine = Math.min(metrics.length - 1, line + scrollOff);
    const top = metrics[topLine].top;
    const bottom = metrics[bottomLine].top + metrics[bottomLine].height;

    if (top < body.scrollTop) {
      setScrollTop(top);
    } else if (bottom > body.scrollTop + body.clientHeight) {
      setScrollTop(bottom - body.clientHeight);
    }
  }, [metrics, scrollOff]);

  const centerLine = useCallback((line: number) => {
    const body = bodyRef.current;
    const metric = metrics[line];
    if (!body || !metric) return;

    body.scrollTop = clampScrollTop(
      metric.top + metric.height / 2 - body.clientHeight / 2,
      metrics,
      body.clientHeight,
    );
  }, [metrics]);

  const moveCursor = useCallback((next: number, options?: { center?: boolean }) => {
    const line = clampLine(next, lineCount);
    if (line === cursorRef.current) return;

    cursorRef.current = line;
    if (options?.center) {
      centerLine(line);
    } else {
      ensureVisible(line);
    }
    setCursorLine(line);
  }, [centerLine, ensureVisible, lineCount]);

  useEffect(() => {
    if (prevFileRef.current && prevFileRef.current !== filePath) {
      cursorMapRef.current.set(prevFileRef.current, cursorRef.current);
    }
    prevFileRef.current = filePath;

    const saved = filePath ? cursorMapRef.current.get(filePath) ?? 0 : 0;
    cursorRef.current = saved;
    setCursorLine(saved);
    setVisualAnchor(null);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [filePath]);

  useEffect(() => {
    const line = clampLine(cursorRef.current, lineCount);
    cursorRef.current = line;
    setCursorLine(line);
  }, [lineCount]);

  useEffect(() => {
    ensureVisible(cursorRef.current);
  }, [ensureVisible, scrollOff]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    const syncViewport = () => {
      setViewport({
        scrollTop: body.scrollTop,
        height: body.clientHeight,
        width: body.clientWidth,
      });
    };

    syncViewport();
    body.addEventListener("scroll", syncViewport, { passive: true });
    const resizeObserver = new ResizeObserver(syncViewport);
    resizeObserver.observe(body);

    return () => {
      body.removeEventListener("scroll", syncViewport);
      resizeObserver.disconnect();
    };
  }, [filePath, loading]);

  const placementForRange = useCallback((start: number, end: number): Placement | undefined => {
    const body = bodyRef.current;
    const startMetric = metrics[start];
    const endMetric = metrics[end] ?? startMetric;
    if (!body || !startMetric || !endMetric) return undefined;

    const rect = body.getBoundingClientRect();
    const selectionBottom = rect.top + endMetric.top + endMetric.height - body.scrollTop;
    const selectionTop = rect.top + startMetric.top - body.scrollTop;
    const x = clamp(rect.left + CODE_PAD_LEFT - body.scrollLeft, 12, window.innerWidth - POPOVER_WIDTH - 12);
    const below = selectionBottom + POPOVER_GAP;
    const above = selectionTop - POPOVER_GAP - POPOVER_ESTIMATED_HEIGHT;
    const y = below + POPOVER_ESTIMATED_HEIGHT <= window.innerHeight - 12
      ? below
      : clamp(above, 12, window.innerHeight - POPOVER_ESTIMATED_HEIGHT - 12);

    return { x, y };
  }, [metrics]);

  const cursorAnchors = useMemo(() => {
    const line = cursorLine + 1;
    return anchors
      .filter(a => a.startLine <= line && line <= a.endLine)
      .sort((a, b) => {
        const aSize = a.endLine - a.startLine;
        const bSize = b.endLine - b.startLine;
        return aSize - bSize || a.startLine - b.startLine || a.id.localeCompare(b.id);
      });
  }, [anchors, cursorLine]);

  const activeAnchorIndex = cursorAnchors.length === 0 ? -1 : anchorStackIndex % cursorAnchors.length;
  const activeCursorAnchor = activeAnchorIndex >= 0 ? cursorAnchors[activeAnchorIndex] : null;

  // Assign each anchor a horizontal "lane" so overlapping threads render as
  // distinct side-by-side gutter bars instead of stacking on top of each other.
  // Largest ranges get the leftmost lane (outer-left), nested ones shift right.
  const anchorLanes = useMemo(() => {
    const lanes = new Map<string, number>();
    const laneRanges: Array<Array<{ start: number; end: number }>> = [];
    const sorted = [...anchors].sort((a, b) => {
      const aSize = a.endLine - a.startLine;
      const bSize = b.endLine - b.startLine;
      return bSize - aSize || a.startLine - b.startLine || a.id.localeCompare(b.id);
    });
    for (const a of sorted) {
      let lane = 0;
      while ((laneRanges[lane] ?? []).some(r => a.startLine <= r.end && r.start <= a.endLine)) {
        lane++;
      }
      if (!laneRanges[lane]) laneRanges[lane] = [];
      laneRanges[lane].push({ start: a.startLine, end: a.endLine });
      lanes.set(a.id, lane);
    }
    return lanes;
  }, [anchors]);

  useEffect(() => {
    setAnchorStackIndex(0);
  }, [cursorLine, filePath]);

  // When the viewer gains focus, blur any lingering input/textarea from other
  // panels so that keydown events target the document (not a foreign input).
  useEffect(() => {
    if (!focused) return;
    const el = document.activeElement as HTMLElement | null;
    if (
      el && el !== document.body &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
    ) {
      el.blur();
    }
  }, [focused]);

  useEffect(() => {
    if (!focused || !filePath || loading) return;

    const handleKey = (e: KeyboardEvent) => {
      // Don't hijack keys while the user is typing in an input/textarea/editable
      // (e.g. the main chat, a selection-chat popover, or the sidebar search).
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
        return;
      }
      if (e.altKey || e.metaKey) return;

      if (e.key === "Escape") {
        e.preventDefault();
        countRef.current = "";
        if (visualAnchor !== null) setVisualAnchor(null);
        return;
      }

      if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        const count = parseInt(countRef.current) || 1;
        countRef.current = "";
        const halfPage = Math.max(1, Math.floor((bodyRef.current?.clientHeight ?? LINE_HEIGHT) / LINE_HEIGHT / 2));
        moveCursor(cursorRef.current + halfPage * count, { center: true });
        return;
      }

      if (e.ctrlKey && e.key === "u") {
        e.preventDefault();
        const count = parseInt(countRef.current) || 1;
        countRef.current = "";
        const halfPage = Math.max(1, Math.floor((bodyRef.current?.clientHeight ?? LINE_HEIGHT) / LINE_HEIGHT / 2));
        moveCursor(cursorRef.current - halfPage * count, { center: true });
        return;
      }

      if (e.ctrlKey) return;

      if (activeCursorAnchor && e.key === "Enter") {
        e.preventDefault();
        countRef.current = "";
        onAnchorClick?.(
          activeCursorAnchor.id,
          placementForRange(activeCursorAnchor.startLine - 1, activeCursorAnchor.endLine - 1),
        );
        return;
      }

      if (cursorAnchors.length > 1 && e.key === "Tab") {
        e.preventDefault();
        countRef.current = "";
        setAnchorStackIndex(prev => (prev + (e.shiftKey ? -1 : 1) + cursorAnchors.length) % cursorAnchors.length);
        return;
      }

      // Accumulate digit keys into count prefix (0 only if count already started)
      if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        countRef.current += e.key;
        return;
      }
      if (e.key === "0" && countRef.current.length > 0) {
        e.preventDefault();
        countRef.current += "0";
        return;
      }

      const hasCount = countRef.current.length > 0;
      const count = parseInt(countRef.current) || 1;
      countRef.current = "";

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          moveCursor(cursorRef.current + count);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          moveCursor(cursorRef.current - count);
          break;
        case "h":
        case "ArrowLeft":
          e.preventDefault();
          if (bodyRef.current) bodyRef.current.scrollLeft = Math.max(0, bodyRef.current.scrollLeft - 40 * count);
          break;
        case "l":
        case "ArrowRight":
          e.preventDefault();
          if (bodyRef.current) bodyRef.current.scrollLeft += 40 * count;
          break;
        case "g":
          e.preventDefault();
          // gg goes to top, {N}gg goes to line N (1-indexed like vim)
          if (hasCount) {
            moveCursor(count - 1);
          } else {
            moveCursor(0);
          }
          break;
        case "G":
          e.preventDefault();
          // G goes to bottom, {N}G goes to line N (1-indexed like vim)
          if (hasCount) {
            moveCursor(count - 1);
          } else {
            moveCursor(lineCount - 1);
          }
          break;
        case "V":
          e.preventDefault();
          setVisualAnchor(anchor => anchor === null ? cursorRef.current : null);
          break;
        case "c":
        case "C": {
          e.preventDefault();
          if (!filePath) break;
          const cur = cursorRef.current;
          const start = visualAnchor === null ? cur : Math.min(visualAnchor, cur);
          const end = visualAnchor === null ? cur : Math.max(visualAnchor, cur);
          const sel: SelectionContext = {
            path: filePath,
            startLine: start + 1,
            endLine: end + 1,
            text: plainLines.slice(start, end + 1).join("\n"),
            lang: lang || undefined,
          };
          // c -> attach to main chat (flow A); C -> create a note (flow B)
          if (e.key === "c") onSendToChat(sel);
          else onCreateNote(sel, placementForRange(start, end));
          setVisualAnchor(null);
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [filePath, focused, lineCount, loading, moveCursor, visualAnchor, plainLines, lang, onSendToChat, onCreateNote, placementForRange, activeCursorAnchor, cursorAnchors, onAnchorClick]);

  useEffect(() => {
    if (!filePath) {
      setContent("");
      setTokens(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setTokens(null);

    fetch(`/api/read?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setContent(data.content || "");
        setLang(data.lang || null);
        setLoading(false);

        if (data.lang) {
          fetch(`/api/highlight?path=${encodeURIComponent(filePath)}`)
            .then(r => r.json())
            .then(hl => {
              if (!cancelled && hl.tokens) setTokens(hl.tokens);
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent("Error reading file");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleLineClick = useCallback((e: React.MouseEvent) => {
    const body = bodyRef.current;
    if (!body) return;

    const rect = body.getBoundingClientRect();
    const y = e.clientY - rect.top + body.scrollTop;
    const line = findLineAtOffset(metrics, y);
    const next = clampLine(line, lineCount);
    cursorRef.current = next;
    setCursorLine(next);
  }, [lineCount, metrics]);

  if (!filePath) {
    return (
      <div className={`viewer ${focused ? "panel-focused" : ""}`} onMouseDown={onFocus}>
        <div className="viewer-placeholder">Select a file to view its contents</div>
      </div>
    );
  }

  const selectionStart = visualAnchor === null ? -1 : Math.min(visualAnchor, cursorLine);
  const selectionEnd = visualAnchor === null ? -1 : Math.max(visualAnchor, cursorLine);

  return (
    <div className={`viewer ${focused ? "panel-focused" : ""}`} onMouseDown={onFocus}>
      <div className="viewer-header">
        <span className="viewer-path">{filePath}</span>
        <div className="viewer-actions">
          {visualAnchor !== null && (
            <span className="viewer-mode">VISUAL LINE <span className="viewer-mode-hint">c chat · C note</span></span>
          )}
          {visualAnchor === null && activeCursorAnchor && (
            <span className={`viewer-anchor-hint ${activeCursorAnchor.open ? "open" : ""}`}>
              NOTE
              <span className="viewer-anchor-hint-keys">
                {activeCursorAnchor.open ? "Enter close" : "Enter open"}
                {cursorAnchors.length > 1 && ` · Tab cycle ${activeAnchorIndex + 1}/${cursorAnchors.length}`}
              </span>
            </span>
          )}
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
          <button
            className={`viewer-wrap-toggle ${scrollOff > 0 ? "active" : ""}`}
            onClick={() => setScrollOff(nextScrollOff(scrollOff))}
            title="Cycle scrolloff"
          >
            SO {scrollOff}
          </button>
          <button className="viewer-close" onClick={onClose}>&times;</button>
        </div>
      </div>
      <div
        className={`viewer-body ${wrap ? "wrap" : "nowrap"} ${relNum ? "rel-numbers" : ""}`}
        ref={bodyRef}
        onMouseDown={handleLineClick}
      >
        {loading ? (
          <div className="viewer-loading">Loading...</div>
        ) : (
          <div className="viewer-sizer" style={{ height, minWidth: wrap ? undefined : `calc(${maxLineLength}ch + 9ch + 16px)` }}>
            {cursorMetric && (
              <div
                className="viewer-cursor"
                style={{
                  top: cursorMetric.top,
                  height: cursorMetric.height,
                  opacity: focused ? 1 : 0,
                }}
              />
            )}
            {anchors.map(a => {
              const startMetric = metrics[a.startLine - 1];
              const endMetric = metrics[a.endLine - 1] ?? startMetric;
              if (!startMetric) return null;
              const height = endMetric.top + endMetric.height - startMetric.top;
              const isActive = activeCursorAnchor?.id === a.id;
              const lane = Math.min(anchorLanes.get(a.id) ?? 0, MAX_ANCHOR_LANES - 1);
              const resolved = a.status === "resolved";
              return (
                <React.Fragment key={a.id}>
                  {(a.open || isActive) && (
                    <div
                      className={`viewer-thread-highlight ${a.open ? "open" : "preview"}`}
                      style={{ top: startMetric.top, height }}
                    />
                  )}
                  <button
                    className={`viewer-anchor ${a.open ? "open" : ""} ${isActive ? "active" : ""} ${resolved ? "resolved" : ""}`}
                    style={{ top: startMetric.top, height, left: lane * ANCHOR_LANE_STEP }}
                    title={`Note on lines ${a.startLine}\u2013${a.endLine}${resolved ? " (resolved)" : ""}`}
                    onMouseDown={e => {
                      e.stopPropagation();
                      e.preventDefault();
                      onAnchorClick?.(a.id, placementForRange(a.startLine - 1, a.endLine - 1));
                    }}
                  />
                </React.Fragment>
              );
            })}
            <pre className={`viewer-code ${tokens ? "shiki" : ""}`}>
              <code>
                {Array.from({ length: range.end - range.start }, (_, offset) => {
                  const i = range.start + offset;
                  const metric = metrics[i];
                  const isCursor = i === cursorLine;
                  const isSelected = i >= selectionStart && i <= selectionEnd;
                  const lineNumber = relNum && !isCursor ? Math.abs(i - cursorLine) : i + 1;
                  return (
                    <span
                      className={`line ${isCursor ? "cursor-line" : ""} ${isSelected ? "selected-line" : ""}`}
                      key={i}
                      style={{ top: metric.top, minHeight: metric.height }}
                    >
                      <span className="line-number">{lineNumber}</span>
                      <span className="line-content">
                        {renderLine(tokens, plainLines, i)}
                      </span>
                    </span>
                  );
                })}
              </code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
