import { readdir, readFile } from "fs/promises";
import { join, relative, resolve } from "path";

const EXCLUDED = new Set(["node_modules", ".git", "dist"]);
const BASE_DIR = resolve(process.env.BASE_DIR || ".");
const PUBLIC_DIR = join(import.meta.dir, "public");

interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/api/tree") {
      const dir = url.searchParams.get("path") || ".";
      const target = resolve(join(BASE_DIR, dir));
      if (!target.startsWith(BASE_DIR)) {
        return new Response("Forbidden", { status: 403 });
      }
      const tree = await buildTree(target, BASE_DIR);
      return new Response(JSON.stringify(tree), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/api/read") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return new Response("Missing path", { status: 400 });
      const target = resolve(join(BASE_DIR, filePath));
      if (!target.startsWith(BASE_DIR)) {
        return new Response("Forbidden", { status: 403 });
      }
      const content = await readFile(target, "utf-8");
      return new Response(JSON.stringify({ content }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Static files
    const filePath = pathname === "/" ? "/index.html" : pathname;
    const file = Bun.file(join(PUBLIC_DIR, filePath));
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

async function buildTree(dir: string, base: string): Promise<TreeNode> {
  const children: TreeNode[] = [];
  const dirEntries = await readdir(dir, { withFileTypes: true });

  for (const entry of dirEntries) {
    if (EXCLUDED.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(base, fullPath);

    if (entry.isDirectory()) {
      children.push(await buildTree(fullPath, base));
    } else if (entry.isFile()) {
      children.push({ name: entry.name, type: "file", path: relPath });
    }
  }

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    name: dir === base ? "." : relative(base, dir) || ".",
    type: "directory",
    path: relative(base, dir),
    children,
  };
}

console.log(`filetree running at http://localhost:3000`);
