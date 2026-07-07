import React, { useState } from "react";
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

export function App() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useSetting("sidebar:open", true);
  const [ocOpen, setOcOpen] = useSetting("oc:open", false);

  return (
    <div className="app-layout">
      <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} onSelectFile={setSelectedFile} />
      <Viewer filePath={selectedFile} onClose={() => setSelectedFile(null)} />
      <OpenCodePanel open={ocOpen} onToggle={() => setOcOpen(!ocOpen)} />
    </div>
  );
}
