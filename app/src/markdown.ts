import type React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Configure marked for safe, compact output
marked.setOptions({
  breaks: true,
  gfm: true,
});

// DOMPurify config matching OpenCode's web UI
const purifyConfig: DOMPurify.Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_ATTR: ["target"],
};

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string;
  const clean = DOMPurify.sanitize(raw, purifyConfig);
  // Wrap <pre> blocks with a container for copy button
  return clean.replace(
    /<pre>([\s\S]*?)<\/pre>/g,
    '<div class="oc-code-wrap"><pre>$1</pre><button class="oc-copy-btn" type="button">Copy</button></div>'
  );
}

// Delegated click handler for copy buttons inside rendered markdown.
export function handleCopyClick(e: React.MouseEvent): void {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("oc-copy-btn")) return;
  const wrap = target.closest(".oc-code-wrap");
  const code = wrap?.querySelector("code");
  if (!code) return;
  navigator.clipboard.writeText(code.textContent || "");
  target.textContent = "Copied";
  setTimeout(() => { target.textContent = "Copy"; }, 1500);
}
