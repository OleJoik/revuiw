import React, { useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import { OpenCodePanel } from "./components/OpenCodePanel";
import { SelectionChat } from "./components/SelectionChat";
import { useSetting } from "./hooks";
import type { Panel } from "./types";
import type { PopoverPlacement, SelectionContext, SelectionThread } from "./opencode";

let threadSeq = 0;

export function App() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useSetting("sidebar:open", true);
  const [ocOpen, setOcOpen] = useSetting("oc:open", false);
  const [focusedPanel, setFocusedPanel] = useState<Panel>("viewer");

  // Selection -> chat wiring.
  // `pendingSelection` is the chip queued for the main panel (flow A).
  // `threads` are persistent selection-anchored chats (flow B); their anchors
  // live in the Viewer gutter. `openIds` tracks which are currently popped open
  // (kept out of storage so nothing auto-reopens on reload).
  // `mainSessionId` is reported by the panel so new threads know what to fork.
  // `activateSession` asks the panel to switch to a session (promote flow).
  const [pendingSelection, setPendingSelection] = useState<SelectionContext | null>(null);
  const [threads, setThreads] = useSetting<SelectionThread[]>("threads", []);
  const [openIds, setOpenIds] = useState<string[]>([]);
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

  const openSelectionChat = useCallback((ctx: SelectionContext, placement?: PopoverPlacement) => {
    const id = `sel-${Date.now().toString(36)}-${++threadSeq}`;
    setThreads(prev => [...prev, { id, ...ctx, parentSessionId: mainSessionId, sessionId: null, placement }]);
    setOpenIds(prev => [...prev, id]);
  }, [mainSessionId, setThreads]);

  // Close popover but keep the anchor — unless it was never used (no session),
  // in which case discard it so stray `C` presses don't litter the gutter.
  const closeThread = useCallback((id: string) => {
    setOpenIds(prev => prev.filter(x => x !== id));
    setThreads(prev => {
      const t = prev.find(x => x.id === id);
      return t && !t.sessionId ? prev.filter(x => x.id !== id) : prev;
    });
  }, [setThreads]);

  const toggleThread = useCallback((id: string, placement?: PopoverPlacement) => {
    if (placement) setThreads(prev => prev.map(t => t.id === id ? { ...t, placement } : t));
    setOpenIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, [setThreads]);

  const removeThread = useCallback((id: string) => {
    setOpenIds(prev => prev.filter(x => x !== id));
    setThreads(prev => prev.filter(t => t.id !== id));
  }, [setThreads]);

  const setThreadSession = useCallback((id: string, sessionId: string) => {
    setThreads(prev => prev.map(t => t.id === id ? { ...t, sessionId } : t));
  }, [setThreads]);

  const promoteSession = useCallback((sessionId: string, threadId: string) => {
    setActivateSession({ id: sessionId, token: Date.now() });
    setOpenIds(prev => prev.filter(x => x !== threadId));
    openChat();
  }, [openChat]);

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

  const anchors = threads
    .filter(t => t.path === selectedFile)
    .map(t => ({ id: t.id, startLine: t.startLine, endLine: t.endLine, open: openIds.includes(t.id) }));

  return (
    <div className="app-layout">
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onSelectFile={(path) => { setSelectedFile(path); setFocusedPanel("viewer"); }}
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
        anchors={anchors}
        onAnchorClick={toggleThread}
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
      {threads.filter(t => openIds.includes(t.id)).map(t => (
        <SelectionChat
          key={t.id}
          thread={t}
          onClose={() => closeThread(t.id)}
          onRemove={() => removeThread(t.id)}
          onSessionCreated={(sessionId) => setThreadSession(t.id, sessionId)}
          onPromote={(sessionId) => promoteSession(sessionId, t.id)}
        />
      ))}
    </div>
  );
}
