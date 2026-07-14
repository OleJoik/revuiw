import { readdir, readFile, writeFile, mkdir, stat, unlink } from "fs/promises";
import { join, relative, resolve, dirname, basename, extname } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { createHighlighter, type Highlighter } from "shiki";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  computeDiffRows, summarize, rebuildIndex, toggleRows,
  type DiffRow,
} from "./review-engine";
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
  note?: string;
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
  if (context && context.note && context.note.trim()) {
    parts.push({ type: "text", text: `Note: ${context.note.trim()}` });
  }
  if (message.trim()) parts.push({ type: "text", text: message });
  return parts;
}

const EXCLUDED = new Set(["node_modules", ".git", "dist", ".revuiw"]);
const ROOTS_FILE = join(homedir(), ".filetree", "roots.json");

// --- Notes storage (.revuiw/notes/) ---

interface NoteData {
  id: string;
  file: string;
  anchorLine: number;
  anchorText: string;
  originalSnippet: string;
  startLine: number;
  endLine: number;
  status: "unresolved" | "resolved";
  body: string;
  createdAt: string;
  updatedAt: string;
}

function notesDir(): string {
  return join(process.cwd(), ".revuiw", "notes");
}

async function ensureNotesDir(): Promise<void> {
  await mkdir(notesDir(), { recursive: true });
}

async function loadAllNotes(): Promise<NoteData[]> {
  await ensureNotesDir();
  const dir = notesDir();
  const entries = await readdir(dir);
  const notes: NoteData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const data = await readFile(join(dir, entry), "utf-8");
      notes.push(JSON.parse(data));
    } catch {}
  }
  return notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function loadNote(id: string): Promise<NoteData | null> {
  try {
    const data = await readFile(join(notesDir(), `${id}.json`), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveNote(note: NoteData): Promise<void> {
  await ensureNotesDir();
  await writeFile(join(notesDir(), `${note.id}.json`), JSON.stringify(note, null, 2));
}

async function deleteNoteFile(id: string): Promise<boolean> {
  try {
    await unlink(join(notesDir(), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

// --- Review (git-native: staged == reviewed) ---
//
// Three content snapshots drive the review view:
//   HEAD    = baseline (last commit)          -> `git show HEAD:<rel>`
//   index   = staged tree = the "reviewed" set -> `git show :<rel>`
//   working = the file on disk
//
// The view is the HEAD -> working diff as rows; each changed row is reviewed
// iff the change is present in the index. "Mark reviewed" stages the selected
// lines, "unmark" unstages them. Staging is done by reconstructing the exact
// desired index content and writing it directly with git plumbing
// (hash-object + update-index) — no patch arithmetic, fully git-native, and it
// works for untracked files too.

async function runGit(cwd: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string }> {
  try {
    // `-c safe.directory=*` keeps git working on mounted/foreign-owned repos
    // (e.g. Docker bind mounts) where its dubious-ownership guard would
    // otherwise make every command fail and tracked files look untracked.
    const proc = Bun.spawn(["git", "-c", "safe.directory=*", ...args], {
      cwd,
      stdin: stdin != null ? Buffer.from(stdin) : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, stdout };
  } catch {
    return { code: 1, stdout: "" };
  }
}

async function findRepoRoot(absFile: string): Promise<string | null> {
  const { code, stdout } = await runGit(dirname(absFile), ["rev-parse", "--show-toplevel"]);
  return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function gitHeadContent(root: string, relPath: string): Promise<string | null> {
  const { code, stdout } = await runGit(root, ["show", `HEAD:${relPath}`]);
  return code === 0 ? stdout : null;
}

async function gitIndexContent(root: string, relPath: string): Promise<string | null> {
  const { code, stdout } = await runGit(root, ["show", `:${relPath}`]);
  return code === 0 ? stdout : null;
}

// Resolve the git file mode: prefer the staged mode, then HEAD, then the
// working file's executable bit, defaulting to a regular file.
async function getMode(root: string, relPath: string): Promise<string> {
  const staged = await runGit(root, ["ls-files", "-s", "--", relPath]);
  let m = staged.stdout.match(/^(\d{6}) /);
  if (m) return m[1];
  const head = await runGit(root, ["ls-tree", "HEAD", "--", relPath]);
  m = head.stdout.match(/^(\d{6}) /);
  if (m) return m[1];
  try {
    const s = await stat(join(root, relPath));
    return s.mode & 0o111 ? "100755" : "100644";
  } catch {
    return "100644";
  }
}

// Write `content` as the staged version of relPath. An empty result for an
// untracked file (nothing staged) removes the index entry entirely.
async function stageIndexContent(root: string, relPath: string, content: string, hasHead: boolean): Promise<void> {
  if (content === "" && !hasHead) {
    await runGit(root, ["update-index", "--force-remove", "--", relPath]);
    return;
  }
  const mode = await getMode(root, relPath);
  const { stdout } = await runGit(root, ["hash-object", "-w", "--path", relPath, "--stdin"], content);
  const sha = stdout.trim();
  if (!sha) return;
  await runGit(root, ["update-index", "--add", "--cacheinfo", `${mode},${sha},${relPath}`]);
}

interface ReviewRow extends DiffRow {
  tokens: Token[] | null;
}

interface ReviewResult {
  inRepo: boolean;
  lang: string | null;
  rows: ReviewRow[];
  changed: boolean;
  fullyReviewed: boolean;
  reviewedRows: number;
  unreviewedRows: number;
}

// Attach a highlighted token line to each row: added/context rows are coloured
// from the working tree (by newLine), deletions from HEAD (by oldLine).
function attachTokens(rows: DiffRow[], head: string | null, working: string, lang: string | null): ReviewRow[] {
  const wTokens = tokenizeCode(working, lang);
  const hTokens = head ? tokenizeCode(head, lang) : null;
  return rows.map((r) => {
    let tokens: Token[] | null = null;
    if (r.kind === "del") tokens = hTokens && r.oldLine ? hTokens[r.oldLine - 1] ?? null : null;
    else tokens = wTokens && r.newLine ? wTokens[r.newLine - 1] ?? null : null;
    return { ...r, tokens };
  });
}

async function computeReview(absFile: string): Promise<ReviewResult | null> {
  let working: string;
  try { working = await readFile(absFile, "utf-8"); } catch { return null; }
  const root = await findRepoRoot(absFile);
  const rel = root ? relative(root, absFile) : "";
  const head = root ? await gitHeadContent(root, rel) : null;
  const index = root ? await gitIndexContent(root, rel) : null;
  const rows = computeDiffRows(head, index, working);
  const summary = summarize(rows);
  const lang = getLang(absFile);
  return { inRepo: !!root, lang, rows: attachTokens(rows, head, working, lang), ...summary };
}

interface MarkOptions { all?: boolean; startRow?: number; endRow?: number; reviewed: boolean }

async function markReview(absFile: string, opts: MarkOptions): Promise<ReviewResult | null> {
  let working: string;
  try { working = await readFile(absFile, "utf-8"); } catch { return null; }
  const root = await findRepoRoot(absFile);
  if (!root) return computeReview(absFile);
  const rel = relative(root, absFile);
  const head = await gitHeadContent(root, rel);
  const index = await gitIndexContent(root, rel);
  let rows = computeDiffRows(head, index, working);

  if (opts.all) {
    rows = toggleRows(rows, 0, rows.length - 1, opts.reviewed);
  } else if (opts.startRow != null && opts.endRow != null) {
    rows = toggleRows(rows, opts.startRow, opts.endRow, opts.reviewed);
  }

  const newIndex = rebuildIndex(rows, working.endsWith("\n"));
  await stageIndexContent(root, rel, newIndex, head !== null);
  return computeReview(absFile);
}

interface SummaryEntry { changed: boolean; fullyReviewed: boolean; unreviewedRows: number }

async function reviewSummary(root: string): Promise<{ files: Record<string, SummaryEntry> }> {
  const changedFiles = new Set<string>();
  const tracked = await runGit(root, ["diff", "--name-only", "HEAD"]);
  if (tracked.code === 0) {
    for (const f of tracked.stdout.split("\n")) if (f.trim()) changedFiles.add(join(root, f.trim()));
  }
  const untracked = await runGit(root, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.code === 0) {
    for (const f of untracked.stdout.split("\n")) if (f.trim()) changedFiles.add(join(root, f.trim()));
  }

  const files: Record<string, SummaryEntry> = {};
  for (const f of changedFiles) {
    const state = await computeReview(f).catch(() => null);
    if (state && state.changed) {
      files[f] = {
        changed: true,
        fullyReviewed: state.fullyReviewed,
        unreviewedRows: state.unreviewedRows,
      };
    }
  }
  return { files };
}

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
  // HMR is disabled: the workspace being reviewed is often the app's own source,
  // and hot-reloading would reload the browser mid-review whenever the agent
  // edits a served asset (style.css / index.html), dropping in-flight requests.
  development: { hmr: false, console: process.env.NODE_ENV === "development" },
  routes: {
    "/": homepage,
  },
  async fetch(req) {
    try {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/api/roots" && req.method === "GET") {
        let roots = await loadRoots();
        if (roots.length === 0) {
          const cwd = process.cwd();
          const isGit = await isGitRepo(cwd);
          const entry: RootEntry = {
            path: cwd,
            label: basename(cwd),
            type: isGit ? "git" : "dir",
            branch: isGit ? await getGitBranch(cwd) : undefined,
          };
          roots.push(entry);
          await saveRoots(roots);
        }
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

      if (pathname === "/api/dirs") {
        const dir = resolve(url.searchParams.get("path") || "/");
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith(".") && !EXCLUDED.has(e.name))
            .map(e => ({ name: e.name, path: join(dir, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return new Response(JSON.stringify({ parent: dirname(dir), current: dir, dirs }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          return new Response(JSON.stringify({ parent: dirname(dir), current: dir, dirs: [] }), {
            headers: { "Content-Type": "application/json" },
          });
        }
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

      // --- Notes API endpoints ---

      if (pathname === "/api/notes" && req.method === "GET") {
        const notes = await loadAllNotes();
        return new Response(JSON.stringify(notes), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/notes" && req.method === "POST") {
        const body = await req.json();
        const now = new Date().toISOString();
        const note: NoteData = {
          id: randomUUID(),
          file: body.file,
          anchorLine: body.anchorLine,
          anchorText: body.anchorText || "",
          originalSnippet: body.originalSnippet || "",
          startLine: body.startLine || body.anchorLine,
          endLine: body.endLine || body.anchorLine,
          status: "unresolved",
          body: body.body || "",
          createdAt: now,
          updatedAt: now,
        };
        await saveNote(note);
        return new Response(JSON.stringify(note), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      const noteIdMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (noteIdMatch && req.method === "PATCH") {
        const id = noteIdMatch[1];
        const existing = await loadNote(id);
        if (!existing) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        const body = await req.json();
        if (body.body !== undefined) existing.body = body.body;
        if (body.status !== undefined) existing.status = body.status;
        if (body.anchorLine !== undefined) existing.anchorLine = body.anchorLine;
        if (body.anchorText !== undefined) existing.anchorText = body.anchorText;
        existing.updatedAt = new Date().toISOString();
        await saveNote(existing);
        return new Response(JSON.stringify(existing), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (noteIdMatch && req.method === "DELETE") {
        const id = noteIdMatch[1];
        const ok = await deleteNoteFile(id);
        if (!ok) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // --- Review API endpoints ---

      if (pathname === "/api/review" && req.method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const state = await computeReview(resolve(filePath));
        const body = state ?? { inRepo: false, lang: null, rows: [], changed: false, fullyReviewed: true, reviewedRows: 0, unreviewedRows: 0 };
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/review/mark" && req.method === "POST") {
        const body = await req.json();
        if (!body.path) return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const state = await markReview(resolve(body.path), {
          all: body.all === true,
          startRow: body.startRow,
          endRow: body.endRow,
          reviewed: body.reviewed !== false,
        });
        return new Response(JSON.stringify(state), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/review/summary" && req.method === "GET") {
        const rootParam = url.searchParams.get("root");
        if (!rootParam) return new Response(JSON.stringify({ error: "Missing root" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const root = (await findRepoRoot(resolve(rootParam))) ?? resolve(rootParam);
        const summary = await reviewSummary(root);
        return new Response(JSON.stringify(summary), {
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

      const sessionDeleteMatch = pathname.match(/^\/api\/opencode\/sessions\/([^/]+)$/);
      if (sessionDeleteMatch && req.method === "DELETE") {
        const sessionId = sessionDeleteMatch[1];
        const { error } = await opencode.session.delete({ sessionID: sessionId });
        if (error) return new Response(JSON.stringify({ error: "Failed to delete session" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pathname === "/api/opencode/models" && req.method === "GET") {
        const { data, error } = await opencode.v2.model.list();
        if (error) return new Response(JSON.stringify({ error: "Failed to list models" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const sessionModelMatch = pathname.match(/^\/api\/opencode\/sessions\/([^/]+)\/model$/);
      if (sessionModelMatch && req.method === "PUT") {
        const sessionId = sessionModelMatch[1];
        const body = await req.json();
        const { data, error } = await opencode.v2.session.switchModel({ sessionID: sessionId, model: body.model });
        if (error) return new Response(JSON.stringify({ error: "Failed to switch model" }), { status: 502, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify(data ?? { ok: true }), {
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
