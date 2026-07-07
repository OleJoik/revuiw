import React, { useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import { OpenCodePanel } from "./components/OpenCodePanel";
import { SelectionChat } from "./components/SelectionChat";
import { useSetting } from "./hooks";
import type { SelectionContext } from "./opencode";

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

// An open ephemeral selection chat (flow B). Each forks from the current main
// session so it inherits context while keeping its own tangent history.
interface Popover {
  id: string;
  context: SelectionContext;
  parentSessionId: string | null;
}

let popoverSeq = 0;

export function App() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useSetting("sidebar:open", true);
  const [ocOpen, setOcOpen] = useSetting("oc:open", false);
  const [focusedPanel, setFocusedPanel] = useState<Panel>("viewer");

  // Selection -> chat wiring.
  // `pendingSelection` is the chip queued for the main panel (flow A).
  // `popovers` are floating forked chats bound to a selection (flow B).
  // `mainSessionId` is reported by the panel so popovers know what to fork.
  // `activateSession` asks the panel to switch to a session (promote flow).
  const [pendingSelection, setPendingSelection] = useState<SelectionContext | null>(null);
  const [popovers, setPopovers] = useState<Popover[]>([]);
  const [mainSessionId, setMainSessionId] = useState<string | null>(null);
  const [activateSession, setActivateSession] = useState<{ id: string; token: number } | null>(null);

  const openChat = useCallback(() => {
    setOcOpen(true);
    setFocusedPanel("chat");
  }, [setOcOpen]);

  const sendSelectionToChat = useCallback((ctx: SelectionContext) => {
    setPendingSelection(ctx);
    openChat();
  }, [openChat]);

  const openSelectionChat = useCallback((ctx: SelectionContext) => {
    setPopovers(prev => [...prev, { id: `sel-${++popoverSeq}`, context: ctx, parentSessionId: mainSessionId }]);
  }, [mainSessionId]);

  const closePopover = useCallback((id: string) => {
    setPopovers(prev => prev.filter(p => p.id !== id));
  }, []);

  const promoteSession = useCallback((id: string, popoverId: string) => {
    setActivateSession({ id, token: Date.now() });
    closePopover(popoverId);
    openChat();
  }, [closePopover, openChat]);

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
        onSendToChat={sendSelectionToChat}
        onOpenSelectionChat={openSelectionChat}
      />
      <OpenCodePanel
        open={ocOpen}
        onToggle={() => setOcOpen(!ocOpen)}
        focused={focusedPanel === "chat"}
        onFocus={() => setFocusedPanel("chat")}
        pendingSelection={pendingSelection}
        onConsumeSelection={() => setPendingSelection(null)}
        onSessionChange={setMainSessionId}
        activateSession={activateSession}
      />
      {popovers.map(p => (
        <SelectionChat
          key={p.id}
          context={p.context}
          parentSessionId={p.parentSessionId}
          onClose={() => closePopover(p.id)}
          onPromote={(sessionId) => promoteSession(sessionId, p.id)}
        />
      ))}
    </div>
  );
}
