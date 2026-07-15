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

// --- Client-side syntax highlighting via server-side shiki ---

const highlightCache = new Map<string, string>();

/**
 * Find all <code class="language-xxx"> blocks inside `root` that haven't been
 * highlighted yet, send them to the server for shiki tokenization, and replace
 * their innerHTML with highlighted spans.
 */
export async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  // Target both language-tagged and untagged code blocks inside <pre>
  const codeEls = root.querySelectorAll<HTMLElement>("pre > code");
  if (codeEls.length === 0) return;

  const pending: { el: HTMLElement; lang: string; code: string }[] = [];
  for (const el of codeEls) {
    if (el.dataset.highlighted) continue;
    const langMatch = el.className.match(/language-(\S+)/);
    let lang = langMatch ? langMatch[1] : "";
    const code = el.textContent || "";
    if (!code.trim()) continue;

    // Auto-detect for untagged blocks
    if (!lang) {
      if (/\b(const|let|var|function|import|export|=>)\b/.test(code)) lang = "typescript";
      else if (/\b(def |class |import |from |print\()/.test(code)) lang = "python";
      else if (/\b(func |package |fmt\.)/.test(code)) lang = "go";
      else continue; // skip if we can't guess
    }

    const cacheKey = `${lang}:${code}`;
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      el.innerHTML = cached;
      el.dataset.highlighted = "1";
      continue;
    }
    pending.push({ el, lang, code });
  }

  // Batch requests (fire all in parallel, cap at 10 concurrent)
  const batch = pending.slice(0, 20);
  await Promise.all(batch.map(async ({ el, lang, code }) => {
    try {
      const res = await fetch("/api/highlight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, lang }),
      });
      const data = await res.json();
      if (data.html) {
        const cacheKey = `${lang}:${code}`;
        highlightCache.set(cacheKey, data.html);
        el.innerHTML = data.html;
      }
    } catch { /* ignore */ }
    el.dataset.highlighted = "1";
  }));
}
