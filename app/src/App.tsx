import React, { useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import { OpenCodePanel } from "./components/OpenCodePanel";
import { useSetting } from "./hooks";

export interface RootEntry {
  path: string;
  label: string;
  type: "git" | "dir";
  branch?: string;
}

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

export type Panel = "sidebar" | "viewer" | "chat";

export function App() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useSetting("sidebar:open", true);
  const [ocOpen, setOcOpen] = useSetting("oc:open", false);
  const [focusedPanel, setFocusedPanel] = useState<Panel>("viewer");

  // Get ordered list of visible panels
  const getVisiblePanels = useCallback((): Panel[] => {
    const panels: Panel[] = [];
    if (sidebarOpen) panels.push("sidebar");
    panels.push("viewer");
    if (ocOpen) panels.push("chat");
    return panels;
  }, [sidebarOpen, ocOpen]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ctrl+e: toggle explorer
      if (e.ctrlKey && e.key === "e") {
        e.preventDefault();
        if (sidebarOpen && focusedPanel === "sidebar") {
          setSidebarOpen(false);
        } else {
          if (!sidebarOpen) setSidebarOpen(true);
          setFocusedPanel("sidebar");
        }
        return;
      }

      // Ctrl+s: toggle chat
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (ocOpen && focusedPanel === "chat") {
          setOcOpen(false);
        } else {
          if (!ocOpen) setOcOpen(true);
          setFocusedPanel("chat");
        }
        return;
      }

      // Ctrl+h / Ctrl+ArrowLeft: focus panel to the left
      if (e.ctrlKey && (e.key === "h" || e.key === "ArrowLeft")) {
        e.preventDefault();
        const panels = getVisiblePanels();
        const idx = panels.indexOf(focusedPanel);
        if (idx > 0) setFocusedPanel(panels[idx - 1]);
        return;
      }

      // Ctrl+l / Ctrl+ArrowRight: focus panel to the right
      if (e.ctrlKey && (e.key === "l" || e.key === "ArrowRight")) {
        e.preventDefault();
        const panels = getVisiblePanels();
        const idx = panels.indexOf(focusedPanel);
        if (idx < panels.length - 1) setFocusedPanel(panels[idx + 1]);
        return;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [focusedPanel, sidebarOpen, ocOpen, getVisiblePanels]);

  // If focused panel gets closed, move focus to viewer
  useEffect(() => {
    if (focusedPanel === "sidebar" && !sidebarOpen) setFocusedPanel("viewer");
    if (focusedPanel === "chat" && !ocOpen) setFocusedPanel("viewer");
  }, [sidebarOpen, ocOpen]);

  return (
    <div className="app-layout">
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onSelectFile={setSelectedFile}
        focused={focusedPanel === "sidebar"}
        onFocus={() => setFocusedPanel("sidebar")}
      />
      <Viewer
        filePath={selectedFile}
        onClose={() => setSelectedFile(null)}
        focused={focusedPanel === "viewer"}
        onFocus={() => setFocusedPanel("viewer")}
      />
      <OpenCodePanel
        open={ocOpen}
        onToggle={() => setOcOpen(!ocOpen)}
        focused={focusedPanel === "chat"}
        onFocus={() => setFocusedPanel("chat")}
      />
    </div>
  );
}
