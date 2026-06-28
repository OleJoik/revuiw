import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, relative, resolve, dirname, basename } from "path";
import { homedir } from "os";

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
        const content = await readFile(resolve(filePath), "utf-8");
        return new Response(JSON.stringify({ content }), {
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

      const staticPath = pathname === "/" ? "/index.html" : pathname;
      const file = Bun.file(join(import.meta.dir, "public", staticPath));
      if (await file.exists()) return new Response(file);

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
