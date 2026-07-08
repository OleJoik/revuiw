import React, { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useSetting } from "../hooks";
import type { RootEntry, TreeNode } from "../types";

interface Props {
  open: boolean;
  onToggle: () => void;
  onSelectFile: (path: string) => void;
  focused: boolean;
  onFocus: () => void;
}

// Flatten visible tree nodes for keyboard navigation
function flattenVisible(node: TreeNode, expanded: Set<string>, isRoot: boolean, search: string): TreeNode[] {
  const result: TreeNode[] = [];

  if (search && !matchesSearch(node, search)) return result;
  if (!isRoot) result.push(node);

  if (node.type === "directory" && (isRoot || expanded.has(node.path))) {
    for (const child of node.children || []) {
      result.push(...flattenVisible(child, expanded, false, search));
    }
  }

  return result;
}

export function Sidebar({ open, onToggle, onSelectFile, focused, onFocus }: Props) {
  const [width, setWidth] = useSetting("sidebar:width", 300);
  const [roots, setRoots] = useState<RootEntry[]>([]);
  const [currentRoot, setCurrentRoot] = useSetting<string | null>("currentRoot", null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useSetting("showHidden", false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [treeActive, setTreeActive] = useState(false);
  const [showRootPicker, setShowRootPicker] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const dragging = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Flatten visible nodes for keyboard cursor movement
  const visibleNodes = useMemo(() => {
    if (!tree) return [];
    return flattenVisible(tree, expanded, true, search.toLowerCase());
  }, [tree, expanded, search]);

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

  // Restore focus within sidebar when panel receives focus
  useEffect(() => {
    if (focused && open) {
      if (treeActive) {
        searchRef.current?.blur();
      } else {
        searchRef.current?.focus();
      }
    }
  }, [focused]);

  // Keyboard navigation when focused
  useEffect(() => {
    if (!focused || !open) return;

    const handleKey = (e: KeyboardEvent) => {
      // Ignore typing in foreign inputs (main chat, selection popovers). The
      // sidebar's own search box is handled explicitly below.
      const target = e.target as HTMLElement | null;
      if (
        target && target !== searchRef.current &&
        (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      ) {
        return;
      }

      // Ctrl+j: enter tree navigation mode
      if (e.ctrlKey && e.key === "j") {
        e.preventDefault();
        setTreeActive(true);
        searchRef.current?.blur();
        // Place cursor on first item if none
        if (!cursor && visibleNodes.length > 0) setCursor(visibleNodes[0].path);
        return;
      }

      // Ctrl+k: back to search mode
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        setTreeActive(false);
        searchRef.current?.focus();
        return;
      }

      // If in search mode, only handle Escape to enter tree
      if (!treeActive) {
        if (e.key === "Escape") {
          e.preventDefault();
          setTreeActive(true);
          searchRef.current?.blur();
          if (!cursor && visibleNodes.length > 0) setCursor(visibleNodes[0].path);
        }
        return;
      }

      // Tree navigation mode
      const cursorIdx = cursor ? visibleNodes.findIndex(n => n.path === cursor) : -1;

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          const next = Math.min(cursorIdx + 1, visibleNodes.length - 1);
          if (visibleNodes[next]) setCursor(visibleNodes[next].path);
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          const next = Math.max(cursorIdx - 1, 0);
          if (visibleNodes[next]) setCursor(visibleNodes[next].path);
          break;
        }
        case "l":
        case "ArrowRight": {
          e.preventDefault();
          if (cursor) {
            const node = visibleNodes.find(n => n.path === cursor);
            if (node?.type === "directory" && !expanded.has(cursor)) {
              toggleExpand(cursor);
            }
          }
          break;
        }
        case "h":
        case "ArrowLeft": {
          e.preventDefault();
          if (cursor) {
            const node = visibleNodes.find(n => n.path === cursor);
            if (node?.type === "directory" && expanded.has(cursor)) {
              toggleExpand(cursor);
            }
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (cursor) {
            const node = visibleNodes.find(n => n.path === cursor);
            if (node?.type === "file") onSelectFile(cursor);
            else if (node?.type === "directory") toggleExpand(cursor);
          }
          break;
        }
        case "/": {
          // Back to search
          e.preventDefault();
          setTreeActive(false);
          searchRef.current?.focus();
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [focused, open, cursor, visibleNodes, expanded, treeActive]);

  // Keep cursor on a valid visible node when search changes
  useEffect(() => {
    if (visibleNodes.length === 0) {
      setCursor(null);
    } else if (!cursor || !visibleNodes.some(n => n.path === cursor)) {
      setCursor(visibleNodes[0].path);
    }
  }, [visibleNodes]);

  // Scroll cursor into view
  useEffect(() => {
    if (!cursor || !treeRef.current) return;
    const el = treeRef.current.querySelector(`[data-path="${CSS.escape(cursor)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const addRoot = (path: string) => {
    if (!path.trim()) return;
    fetch("/api/roots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.trim() }),
    })
      .then(r => r.json())
      .then(data => {
        setRoots(data);
        const added = data[data.length - 1];
        if (added) setCurrentRoot(added.path);
        setBrowsePath(null);
        setShowRootPicker(false);
      })
      .catch(() => {});
  };

  const browseTo = (path: string) => {
    setBrowsePath(path);
    fetch(`/api/dirs?path=${encodeURIComponent(path)}`)
      .then(r => r.json())
      .then(data => {
        setBrowseDirs(data.dirs);
        setBrowseParent(data.parent !== data.current ? data.parent : null);
      })
      .catch(() => { setBrowseDirs([]); setBrowseParent(null); });
  };

  const removeRoot = (path: string) => {
    fetch("/api/roots", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
      .then(r => r.json())
      .then(data => {
        setRoots(data);
        if (currentRoot === path) {
          setCurrentRoot(data.length > 0 ? data[0].path : null);
        }
      })
      .catch(() => {});
  };

  const activeRoot = roots.find(r => r.path === currentRoot);

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
    <div className={`sidebar ${focused ? "panel-focused" : ""}`} style={{ width }} onMouseDown={onFocus}>
      <div className="sidebar-header">
        <span className="sidebar-root-label" title={currentRoot || undefined}>
          {activeRoot ? activeRoot.label : "No folder"}
          {activeRoot?.branch && <span className="sidebar-root-branch">{activeRoot.branch}</span>}
        </span>
        <button
          className="sidebar-root-add"
          onClick={() => { setShowRootPicker(true); if (!browsePath) browseTo("/"); }}
          title="Open folder"
        >+</button>
        <button className="sidebar-close" onClick={onToggle} title="Close sidebar">&times;</button>
      </div>
      {showRootPicker && createPortal(
        <div className="root-modal-backdrop" onMouseDown={() => { setShowRootPicker(false); setBrowsePath(null); }}>
          <div className="root-modal" onMouseDown={e => e.stopPropagation()}>
            <div className="root-modal-header">
              <span className="root-modal-title">Open Folder</span>
              <button className="root-modal-close" onClick={() => { setShowRootPicker(false); setBrowsePath(null); }}>&times;</button>
            </div>
            {roots.length > 0 && (
              <div className="root-modal-section">
                <div className="root-modal-section-label">Recent</div>
                {roots.map(r => (
                  <div
                    key={r.path}
                    className={`root-modal-item ${r.path === currentRoot ? "active" : ""}`}
                    onClick={() => { setCurrentRoot(r.path); setShowRootPicker(false); setBrowsePath(null); }}
                  >
                    <span className="root-modal-item-label">{r.label}{r.branch ? ` [${r.branch}]` : ""}</span>
                    <span className="root-modal-item-path">{r.path}</span>
                    {roots.length > 1 && (
                      <button
                        className="root-modal-item-remove"
                        onClick={(e) => { e.stopPropagation(); removeRoot(r.path); }}
                        title="Remove"
                      >&times;</button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="root-modal-section">
              <div className="root-modal-section-label">Browse</div>
              <div className="root-modal-browse">
                <div className="root-modal-browse-header">
                  {browseParent && (
                    <button className="sidebar-browse-up" onClick={() => browseTo(browseParent)}>&larr;</button>
                  )}
                  <span className="sidebar-browse-path" title={browsePath || undefined}>{browsePath || "/"}</span>
                  <button className="sidebar-browse-select" onClick={() => browsePath && addRoot(browsePath)}>Open</button>
                </div>
                <div className="root-modal-browse-list">
                  {browseDirs.map(d => (
                    <div key={d.path} className="sidebar-browse-dir" onClick={() => browseTo(d.path)}>
                      {d.name}
                    </div>
                  ))}
                  {browseDirs.length === 0 && <div className="sidebar-browse-empty">No subdirectories</div>}
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
      <div className="sidebar-search">
        <input
          ref={searchRef}
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
      <div className={`sidebar-tree ${treeActive ? "tree-navigating" : ""}`} ref={treeRef}>
        {tree ? (
          <TreeView
            node={tree}
            depth={0}
            expanded={expanded}
            onToggle={toggleExpand}
            onSelect={onSelectFile}
            search={search.toLowerCase()}
            cursor={cursor}
            onCursor={(path) => { setCursor(path); setTreeActive(true); searchRef.current?.blur(); }}
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
  node, depth, expanded, onToggle, onSelect, search, cursor, onCursor, isRoot,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  search: string;
  cursor: string | null;
  onCursor: (path: string) => void;
  isRoot?: boolean;
}) {
  const isDir = node.type === "directory";
  const isOpen = expanded.has(node.path);
  const matches = search ? matchesSearch(node, search) : true;
  const isCursor = cursor === node.path;

  if (search && !matches) return null;

  return (
    <>
      {!isRoot && (
        <div
          className={`tree-node ${isDir ? "dir" : "file"} ${isCursor ? "cursor" : ""}`}
          style={{ paddingLeft: depth * 14 + 6 }}
          data-path={node.path}
          onClick={() => { onCursor(node.path); isDir ? onToggle(node.path) : onSelect(node.path); }}
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
          cursor={cursor}
          onCursor={onCursor}
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
