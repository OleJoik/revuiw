let roots = [];
let currentRoot = null;
let treeData = null;
let expanded = new Set();
let selectedPath = null;
let searchQuery = "";

const rootCurrentEl = document.getElementById("root-current");
const rootInputEl = document.getElementById("root-input");
const rootAddBtn = document.getElementById("root-add-btn");
const rootScanBtn = document.getElementById("root-scan-btn");
const rootListEl = document.getElementById("root-list");
const treeEl = document.getElementById("tree");
const searchEl = document.getElementById("search");
const placeholderEl = document.getElementById("viewer-placeholder");
const viewerContentEl = document.getElementById("viewer-content");
const viewerPathEl = document.getElementById("viewer-path");
const viewerBodyEl = document.getElementById("viewer-body");
const viewerCloseEl = document.getElementById("viewer-close");

// ---- Roots ----

async function loadRoots() {
  const res = await fetch("/api/roots");
  roots = await res.json();
  renderRoots();

  if (!currentRoot && roots.length > 0) {
    selectRoot(roots[0].path);
  }
}

function renderRoots() {
  rootCurrentEl.innerHTML = "";
  rootListEl.innerHTML = "";

  if (!currentRoot) {
    rootCurrentEl.innerHTML = '<span class="label" style="color:var(--fg-muted)">No root selected</span>';
    rootListEl.classList.remove("open");
    return;
  }

  const cr = roots.find(r => r.path === currentRoot);
  if (cr) {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = cr.label;
    rootCurrentEl.appendChild(label);
    if (cr.branch) {
      const badge = document.createElement("span");
      badge.className = "branch";
      badge.textContent = cr.branch;
      rootCurrentEl.appendChild(badge);
    }
  }

  rootCurrentEl.style.cursor = "pointer";
  rootCurrentEl.title = roots.length > 0 ? "Click to toggle roots list" : "";
  rootCurrentEl.onclick = () => {
    if (roots.length > 0) rootListEl.classList.toggle("open");
  };

  if (roots.length === 0) {
    rootListEl.classList.remove("open");
    return;
  }

  rootListEl.classList.add("open");

  for (const r of roots) {
    const item = document.createElement("div");
    item.className = "root-item";
    if (r.path === currentRoot) item.classList.add("active");

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = r.label;
    item.appendChild(label);

    if (r.branch) {
      const badge = document.createElement("span");
      badge.className = "branch";
      badge.textContent = r.branch;
      item.appendChild(badge);
    }

    const path = document.createElement("span");
    path.className = "path";
    path.textContent = r.path;
    item.appendChild(path);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetch("/api/roots", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: r.path }),
      });
      if (currentRoot === r.path) {
        currentRoot = null;
        selectedPath = null;
        treeData = null;
        expanded.clear();
        renderTree();
      }
      await loadRoots();
    });
    item.appendChild(removeBtn);

    item.addEventListener("click", () => selectRoot(r.path));
    rootListEl.appendChild(item);
  }
}

async function selectRoot(path) {
  if (currentRoot === path) return;
  currentRoot = path;
  selectedPath = null;
  viewerContentEl.style.display = "none";
  placeholderEl.style.display = "flex";
  expanded.clear();
  searchQuery = "";
  searchEl.value = "";
  renderRoots();
  await loadTree();
}

rootAddBtn.addEventListener("click", async () => {
  const p = rootInputEl.value.trim();
  if (!p) return;
  rootInputEl.value = "";
  await fetch("/api/roots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p }),
  });
  await loadRoots();
  if (!currentRoot) {
    const updated = await (await fetch("/api/roots")).json();
    if (updated.length > 0) await selectRoot(updated[updated.length - 1].path);
  }
});

rootInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") rootAddBtn.click();
});

rootScanBtn.addEventListener("click", async () => {
  const dir = currentRoot || "/workspace";
  const res = await fetch(`/api/scan?path=${encodeURIComponent(dir)}`);
  const repos = await res.json();
  for (const repo of repos) {
    await fetch("/api/roots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo }),
    });
  }
  await loadRoots();
});

// ---- Tree ----

async function loadTree() {
  if (!currentRoot) {
    treeEl.innerHTML = '<div class="loading">Select a root to browse</div>';
    return;
  }
  treeEl.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const res = await fetch(`/api/tree?path=${encodeURIComponent(currentRoot)}`);
    if (!res.ok) throw new Error("Failed to load tree");
    treeData = await res.json();
    renderTree();
  } catch {
    treeEl.innerHTML = '<div class="loading" style="color:#f38ba8">Failed to load directory</div>';
  }
}

function renderTree() {
  treeEl.innerHTML = "";
  if (!treeData) return;
  const frag = document.createDocumentFragment();
  renderNode(treeData, frag, 0, true);
  treeEl.appendChild(frag);
}

function countMatches(node, query) {
  if (!query) return 0;
  let count = 0;
  if (node.name.toLowerCase().includes(query)) count++;
  if (node.children) {
    for (const child of node.children) count += countMatches(child, query);
  }
  return count;
}

function toggleExpand(path) {
  if (expanded.has(path)) expanded.delete(path);
  else expanded.add(path);
  renderTree();
}

function selectFile(path) {
  selectedPath = path;
  renderTree();
  loadFile(path);
}

async function loadFile(path) {
  placeholderEl.style.display = "none";
  viewerContentEl.style.display = "flex";
  viewerPathEl.textContent = path;
  viewerBodyEl.textContent = "Loading...";
  try {
    const res = await fetch(`/api/read?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error("Failed to read file");
    const data = await res.json();
    viewerBodyEl.textContent = data.content;
  } catch {
    viewerBodyEl.textContent = "Error reading file";
  }
}

viewerCloseEl.addEventListener("click", () => {
  selectedPath = null;
  placeholderEl.style.display = "flex";
  viewerContentEl.style.display = "none";
  renderTree();
});

function renderNode(node, parent, depth, isRoot) {
  const nodePath = node.path;
  const isDir = node.type === "directory";
  const isOpen = expanded.has(nodePath);

  let matchCount = 0;
  let nodeMatches = false;
  if (searchQuery) {
    matchCount = countMatches(node, searchQuery);
    nodeMatches = node.name.toLowerCase().includes(searchQuery);
  }

  const hasSearch = searchQuery.length > 0;
  if (hasSearch && matchCount === 0) return;

  const row = document.createElement("div");
  row.className = "tree-node";
  if (isDir) row.classList.add("type-directory");
  else row.classList.add("type-file");
  if (selectedPath === nodePath && !isDir) row.classList.add("selected");
  row.style.paddingLeft = (isRoot ? 4 : depth * 16 + 4) + "px";

  const caret = document.createElement("span");
  caret.className = "caret";
  if (isDir) {
    caret.textContent = "\u25B8";
    if (isOpen) caret.classList.add("open");
  } else {
    caret.textContent = "\u00A0";
  }
  row.appendChild(caret);

  const label = document.createElement("span");
  label.className = "label";

  if (searchQuery && nodeMatches) {
    const idx = node.name.toLowerCase().indexOf(searchQuery);
    if (idx !== -1) {
      label.innerHTML = "";
      const before = document.createTextNode(node.name.slice(0, idx));
      const match = document.createElement("span");
      match.className = "highlight";
      match.textContent = node.name.slice(idx, idx + searchQuery.length);
      const after = document.createTextNode(node.name.slice(idx + searchQuery.length));
      label.appendChild(before);
      label.appendChild(match);
      label.appendChild(after);
    } else {
      label.textContent = node.name;
    }
  } else {
    label.textContent = node.name;
  }

  row.appendChild(label);

  if (hasSearch && matchCount > 1) {
    const badge = document.createElement("span");
    badge.className = "match-count";
    badge.textContent = matchCount;
    row.appendChild(badge);
  }

  row.addEventListener("click", () => {
    if (isDir) toggleExpand(nodePath);
    else selectFile(nodePath);
  });

  parent.appendChild(row);

  if (isDir && isOpen && node.children) {
    for (const child of node.children) {
      renderNode(child, parent, depth + 1, false);
    }
  }
}

// ---- Search ----

let searchTimer = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchEl.value.trim().toLowerCase();
    renderTree();
  }, 150);
});

// ---- Keyboard ----

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    searchEl.focus();
  }
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
    e.preventDefault();
    searchEl.focus();
  }
  if (e.key === "Escape") {
    if (document.activeElement === searchEl) {
      searchEl.blur();
      searchEl.value = "";
      searchQuery = "";
      renderTree();
    } else if (selectedPath) {
      viewerCloseEl.click();
    }
  }
});

// ---- Init ----

loadRoots();
