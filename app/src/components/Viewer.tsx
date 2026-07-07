import React, { useState, useEffect } from "react";
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

  if (!filePath) {
    return (
      <div className={`viewer ${focused ? "panel-focused" : ""}`} onMouseDown={onFocus}>
        <div className="viewer-placeholder">Select a file to view its contents</div>
      </div>
    );
  }

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
      <div className={`viewer-body ${wrap ? "wrap" : "nowrap"}`}>
        {loading ? (
          <div className="viewer-loading">Loading...</div>
        ) : tokens ? (
          <pre className="shiki"><code>{tokens.map((line, i) => (
            <span className="line" key={i}>
              {line.map((t: any, j: number) => (
                <span key={j} style={{ color: t.color }}>{t.content}</span>
              ))}
              {"\n"}
            </span>
          ))}</code></pre>
        ) : (
          <pre>{content}</pre>
        )}
      </div>
    </div>
  );
}
