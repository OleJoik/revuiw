import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, relative, resolve, dirname, basename, extname } from "path";
import { homedir } from "os";
import { createHighlighter, type Highlighter } from "shiki";
import { createOpencodeClient } from "@opencode-ai/sdk";
import homepage from "./public/index.html";

// --- Shiki syntax highlighting setup ---

const LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".md": "markdown",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".dockerfile": "dockerfile",
  ".xml": "xml",
  ".svg": "xml",
  ".vue": "vue",
  ".svelte": "svelte",
  ".php": "php",
};

const SUPPORTED_LANGS = [...new Set(Object.values(LANG_MAP))];
const MAX_HIGHLIGHT_SIZE = 512 * 1024; // skip highlighting for files > 512KB

let highlighter: Highlighter;

async function initHighlighter() {
  highlighter = await createHighlighter({
    themes: ["dark-plus"],
    langs: SUPPORTED_LANGS,
  });
  console.log(`shiki highlighter ready (${SUPPORTED_LANGS.length} languages)`);
}

function getLang(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return LANG_MAP[ext] ?? null;
}

interface Token {
  content: string;
  color: string;
}

function tokenizeCode(code: string, lang: string | null): Token[][] | null {
  if (!lang || code.length > MAX_HIGHLIGHT_SIZE) return null;
  try {
    const { tokens } = highlighter.codeToTokens(code, {
      lang,
      theme: "dark-plus",
    });
    // Flatten to just content + color per token
    return tokens.map(line =>
      line.map(t => ({ content: t.content, color: t.color || "#cdd6f4" }))
    );
  } catch {
    return null;
  }
}

// Initialize highlighter before starting server
await initHighlighter();

// --- OpenCode SDK client ---
const OPENCODE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const opencode = createOpencodeClient({ baseUrl: OPENCODE_URL });

interface SelectionContext {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  lang?: string;
}

type PromptPart = { type: "text"; text: string };

// Build the parts array for a prompt. A visual selection is injected as a
// clearly-labelled fenced code block so the model sees exactly what the user
// highlighted. This can be upgraded to a first-class FilePartInput (with a
// FileSource range) once URL/mime handling is validated against the server.
function buildPromptParts(message: string, context?: SelectionContext | null): PromptPart[] {
  const parts: PromptPart[] = [];
  if (context && context.text.trim()) {
    const lang = context.lang || "";
    const header = `Selected from \`${context.path}\` (lines ${context.startLine}\u2013${context.endLine}):`;
    const fenced = "```" + lang + "\n" + context.text + "\n```";
    parts.push({ type: "text", text: `${header}\n${fenced}` });
  }
  if (message.trim()) parts.push({ type: "text", text: message });
  return parts;
}

const EXCLUDED = new Set(["node_modules", ".git", "dist"]);
const ROOTS_FILE = join(homedir(), ".filetree", "roots.json");

interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

interface RootEntry {
  path: string;
  label: string;
  type: "git" | "dir";
  branch?: string;
}

async function ensureRootsFile() {
  const dir = dirname(ROOTS_FILE);
  await mkdir(dir, { recursive: true });
  try { await stat(ROOTS_FILE); } catch {
    await writeFile(ROOTS_FILE, "[]");
  }
}

async function loadRoots(): Promise<RootEntry[]> {
  await ensureRootsFile();
  const data = await readFile(ROOTS_FILE, "utf-8");
  return JSON.parse(data);
}

async function saveRoots(roots: RootEntry[]) {
  await ensureRootsFile();
  await writeFile(ROOTS_FILE, JSON.stringify(roots, null, 2));
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function getGitBranch(path: string): Promise<string | null> {
  try {
    const head = await readFile(join(path, ".git", "HEAD"), "utf-8");
    const m = head.match(/ref: refs\/heads\/(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function refreshRoot(root: RootEntry): Promise<RootEntry> {
  root.type = (await isGitRepo(root.path)) ? "git" : "dir";
  root.branch = root.type === "git" ? await getGitBranch(root.path) : undefined;
  root.label = basename(root.path);
  return root;
}

async function scanGitRepos(parentPath: string): Promise<string[]> {
  const found: string[] = [];
  try {
    if (await isGitRepo(parentPath)) found.push(parentPath);
    const entries = await readdir(parentPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !EXCLUDED.has(e.name) && !e.name.startsWith(".")) {
        const fp = join(parentPath, e.name);
        if (await isGitRepo(fp)) found.push(fp);
      }
    }
  } catch {}
  return found;
}

Bun.serve({
  port: 3000,
  development: process.env.NODE_ENV === "development",
  routes: {
    "/": homepage,
  },
  async fetch(req) {
    try {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/api/roots" && req.method === "GET") {
        const roots = await loadRoots();
        for (const r of roots) await refreshRoot(r);
        return new Response(JSON.stringify(roots), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/roots" && req.method === "POST") {
        const { path: p } = await req.json();
        if (!p) return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const resolved = resolve(p);
        const isGit = await isGitRepo(resolved);
        const entry: RootEntry = {
          path: resolved,
          label: basename(resolved),
          type: isGit ? "git" : "dir",
          branch: isGit ? await getGitBranch(resolved) : undefined,
        };
        const roots = await loadRoots();
        if (!roots.find(r => r.path === resolved)) {
          roots.push(entry);
          await saveRoots(roots);
        }
        return new Response(JSON.stringify(roots), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/roots" && req.method === "DELETE") {
        const { path: p } = await req.json();
        const roots = (await loadRoots()).filter(r => r.path !== resolve(p));
        await saveRoots(roots);
        return new Response(JSON.stringify(roots), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/scan") {
        const dir = url.searchParams.get("path") || "/workspace";
        const repos = await scanGitRepos(resolve(dir));
        return new Response(JSON.stringify(repos), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/tree") {
        const dirPath = url.searchParams.get("path");
        const showHidden = url.searchParams.get("showHidden") === "true";
        if (!dirPath) return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const tree = await buildTree(resolve(dirPath), showHidden);
        return new Response(JSON.stringify(tree), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/read") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const resolved = resolve(filePath);
        const content = await readFile(resolved, "utf-8");
        const lang = getLang(resolved);
        return new Response(JSON.stringify({ content, lang }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/highlight") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const resolved = resolve(filePath);
        const content = await readFile(resolved, "utf-8");
        const lang = getLang(resolved);
        const tokens = tokenizeCode(content, lang);
        return new Response(JSON.stringify({ tokens }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/dirs") {
        const dirPath = url.searchParams.get("path");
        if (!dirPath) return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json" } });

        const resolved = resolve(dirPath);
        const parent = resolved === "/" ? null : dirname(resolved);
        const isGit = await isGitRepo(resolved);
        const branch = isGit ? await getGitBranch(resolved) : undefined;

        const entries = await readdir(resolved, { withFileTypes: true });
        const dirs = [];
        for (const e of entries) {
          if (e.isDirectory() && !EXCLUDED.has(e.name) && !e.name.startsWith(".")) {
            const fp = join(resolved, e.name);
            const dGit = await isGitRepo(fp);
            dirs.push({
              name: e.name,
              path: fp,
              isGit: dGit,
              branch: dGit ? await getGitBranch(fp) : undefined,
            });
          }
        }

        dirs.sort((a, b) => a.name.localeCompare(b.name));

        return new Response(JSON.stringify({ path: resolved, parent, isGit, branch, dirs }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // --- OpenCode API endpoints ---

      if (pathname === "/api/opencode/sessions" && req.method === "GET") {
        const { data, error } = await opencode.session.list();
        if (error) return new Response(JSON.stringify({ error: "Failed to list sessions" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/opencode/sessions" && req.method === "POST") {
        const body = await req.json();
        const { data, error } = await opencode.session.create({ body: { title: body.title } });
        if (error) return new Response(JSON.stringify({ error: "Failed to create session" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const sessionMsgMatch = pathname.match(/^\/api\/opencode\/sessions\/([^/]+)\/messages$/);
      if (sessionMsgMatch && req.method === "GET") {
        const sessionId = sessionMsgMatch[1];
        const { data, error } = await opencode.session.messages({ path: { id: sessionId } });
        if (error) return new Response(JSON.stringify({ error: "Failed to get messages" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const sessionPromptMatch = pathname.match(/^\/api\/opencode\/sessions\/([^/]+)\/prompt$/);
      if (sessionPromptMatch && req.method === "POST") {
        const sessionId = sessionPromptMatch[1];
        const body = await req.json();
        const parts = buildPromptParts(body.message ?? "", body.context);
        if (parts.length === 0) {
          return new Response(JSON.stringify({ error: "Empty prompt" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const { data, error } = await opencode.session.prompt({
          path: { id: sessionId },
          body: {
            ...(body.agent ? { agent: body.agent } : {}),
            parts,
          },
        });
        if (error) return new Response(JSON.stringify({ error: "Failed to send prompt" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const sessionForkMatch = pathname.match(/^\/api\/opencode\/sessions\/([^/]+)\/fork$/);
      if (sessionForkMatch && req.method === "POST") {
        const sessionId = sessionForkMatch[1];
        const body = await req.json().catch(() => ({}));
        const { data, error } = await opencode.session.fork({
          path: { id: sessionId },
          body: body.messageID ? { messageID: body.messageID } : {},
        });
        if (error) return new Response(JSON.stringify({ error: "Failed to fork session" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
});

async function buildTree(dir: string, showHidden = false): Promise<TreeNode> {
  const children: TreeNode[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const e of entries) {
    if (!showHidden && (EXCLUDED.has(e.name) || e.name.startsWith("."))) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      children.push(await buildTree(full, showHidden));
    } else if (e.isFile()) {
      children.push({ name: e.name, type: "file", path: full });
    }
  }

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { name: basename(dir) || dir, type: "directory", path: dir, children };
}

console.log(`filetree running at http://localhost:3000`);
