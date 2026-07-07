import React, { useState, useEffect, useCallback, useRef } from "react";
import { useSetting } from "../hooks";
import type { RootEntry, TreeNode } from "../App";

interface Props {
  open: boolean;
  onToggle: () => void;
  onSelectFile: (path: string) => void;
}

export function Sidebar({ open, onToggle, onSelectFile }: Props) {
  const [width, setWidth] = useSetting("sidebar:width", 300);
  const [roots, setRoots] = useState<RootEntry[]>([]);
  const [currentRoot, setCurrentRoot] = useSetting<string | null>("currentRoot", null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useSetting("showHidden", false);
  const dragging = useRef(false);

  // Load roots
  useEffect(() => {
    fetch("/api/roots").then(r => r.json()).then(data => {
      setRoots(data);
      if (!currentRoot && data.length > 0) setCurrentRoot(data[0].path);
    }).catch(() => {});
  }, []);

  // Load tree when root changes
  useEffect(() => {
    if (!currentRoot) { setTree(null); return; }
    fetch(`/api/tree?path=${encodeURIComponent(currentRoot)}&showHidden=${showHidden}`)
      .then(r => r.json())
      .then(setTree)
      .catch(() => setTree(null));
  }, [currentRoot, showHidden]);

  // Load saved expanded state
  useEffect(() => {
    if (!currentRoot) return;
    try {
      const saved = localStorage.getItem(`revuiw:expanded:${currentRoot}`);
      if (saved) setExpanded(new Set(JSON.parse(saved)));
      else setExpanded(new Set());
    } catch { setExpanded(new Set()); }
  }, [currentRoot]);

  const saveExpanded = (next: Set<string>) => {
    setExpanded(next);
    if (currentRoot) {
      try { localStorage.setItem(`revuiw:expanded:${currentRoot}`, JSON.stringify([...next])); } catch {}
    }
  };

  const toggleExpand = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    saveExpanded(next);
  };

  // Resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.max(180, Math.min(600, e.clientX)));
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

  if (!open) {
    return (
      <div className="sidebar-tab" onClick={onToggle} title="Open sidebar">
        <span>&#9776;</span>
      </div>
    );
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <select
          className="sidebar-root-select"
          value={currentRoot || ""}
          onChange={e => setCurrentRoot(e.target.value || null)}
        >
          {roots.length === 0 && <option value="">No roots</option>}
          {roots.map(r => (
            <option key={r.path} value={r.path}>
              {r.label}{r.branch ? ` [${r.branch}]` : ""}
            </option>
          ))}
        </select>
        <button className="sidebar-close" onClick={onToggle} title="Close sidebar">&times;</button>
      </div>
      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Search files..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          className={`sidebar-hidden-toggle ${showHidden ? "active" : ""}`}
          onClick={() => setShowHidden(!showHidden)}
          title="Show hidden files"
        >.*</button>
      </div>
      <div className="sidebar-tree">
        {tree ? (
          <TreeView
            node={tree}
            depth={0}
            expanded={expanded}
            onToggle={toggleExpand}
            onSelect={onSelectFile}
            search={search.toLowerCase()}
            isRoot
          />
        ) : (
          <div className="sidebar-empty">
            {currentRoot ? "Loading..." : "Select a root"}
          </div>
        )}
      </div>
      <div className="resize-handle resize-handle-right" onMouseDown={startResize} />
    </div>
  );
}

function TreeView({
  node, depth, expanded, onToggle, onSelect, search, isRoot,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  search: string;
  isRoot?: boolean;
}) {
  const isDir = node.type === "directory";
  const isOpen = expanded.has(node.path);
  const matches = search ? matchesSearch(node, search) : true;

  if (search && !matches) return null;

  return (
    <>
      {!isRoot && (
        <div
          className={`tree-node ${isDir ? "dir" : "file"}`}
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => isDir ? onToggle(node.path) : onSelect(node.path)}
        >
          <span className={`tree-caret ${isDir ? (isOpen ? "open" : "") : "leaf"}`}>
            {isDir ? "\u25B8" : ""}
          </span>
          <span className="tree-label">{node.name}</span>
        </div>
      )}
      {isDir && (isOpen || isRoot) && node.children?.map(child => (
        <TreeView
          key={child.path}
          node={child}
          depth={isRoot ? 0 : depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
          search={search}
        />
      ))}
    </>
  );
}

function matchesSearch(node: TreeNode, query: string): boolean {
  if (node.name.toLowerCase().includes(query)) return true;
  if (node.children) return node.children.some(c => matchesSearch(c, query));
  return false;
}
