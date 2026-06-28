let roots = [];
let currentRoot = null;
let treeData = null;
let expanded = new Set();
let selectedPath = null;
let searchQuery = "";
let showHidden = false;

const rootCurrentEl = document.getElementById("root-current");
const rootBrowseBtn = document.getElementById("root-browse-btn");
const rootScanBtn = document.getElementById("root-scan-btn");
const rootListEl = document.getElementById("root-list");
const browseModal = document.getElementById("browse-modal");
const browsePathEl = document.getElementById("browse-path");
const browseGoBtn = document.getElementById("browse-go");
const browseDirsEl = document.getElementById("browse-dirs");
const browseCancelBtn = document.getElementById("browse-cancel");
const browseSelectBtn = document.getElementById("browse-select");

const treeEl = document.getElementById("tree");
const searchEl = document.getElementById("search");
const toggleHiddenBtn = document.getElementById("toggle-hidden");
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

rootBrowseBtn.addEventListener("click", () => openBrowseModal(currentRoot || "/workspace"));

// ---- Browse modal ----

let currentBrowsePath = null;

async function openBrowseModal(initialPath) {
  currentBrowsePath = initialPath;
  browseModal.style.display = "flex";
  browsePathEl.value = initialPath;
  await loadBrowseDirs(initialPath);
  browsePathEl.focus();
  browsePathEl.select();
}

async function loadBrowseDirs(path) {
  browseDirsEl.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const res = await fetch(`/api/dirs?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load directory");
    currentBrowsePath = data.path;
    browsePathEl.value = data.path;
    renderBrowseDirs(data);
  } catch (err) {
    browseDirsEl.innerHTML = `<div class="empty" style="color:#f38ba8">${err.message}</div>`;
  }
}

function renderBrowseDirs(data) {
  browseDirsEl.innerHTML = "";

  if (data.parent) {
    const row = document.createElement("div");
    row.className = "browse-dir-row";
    row.innerHTML = '<span class="icon">\u25B8</span><span class="label" style="color:var(--fg-muted)">..</span>';
    row.addEventListener("click", () => loadBrowseDirs(data.parent));
    browseDirsEl.appendChild(row);
  }

  if (data.dirs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "(no subdirectories)";
    browseDirsEl.appendChild(empty);
    return;
  }

  for (const d of data.dirs) {
    const row = document.createElement("div");
    row.className = "browse-dir-row";

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "\u25B6";
    row.appendChild(icon);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = d.name;
    row.appendChild(label);

    if (d.isGit && d.branch) {
      const badge = document.createElement("span");
      badge.className = "branch";
      badge.textContent = d.branch;
      row.appendChild(badge);
    }

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "\u203A";
    row.appendChild(arrow);

    row.addEventListener("click", () => loadBrowseDirs(d.path));
    browseDirsEl.appendChild(row);
  }
}

browseGoBtn.addEventListener("click", () => {
  const path = browsePathEl.value.trim();
  if (path) loadBrowseDirs(path);
});

browsePathEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") browseGoBtn.click();
});

browseCancelBtn.addEventListener("click", () => {
  browseModal.style.display = "none";
});

browseSelectBtn.addEventListener("click", async () => {
  if (!currentBrowsePath) return;
  await fetch("/api/roots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: currentBrowsePath }),
  });
  browseModal.style.display = "none";
  await loadRoots();
  if (currentRoot !== currentBrowsePath) {
    await selectRoot(currentBrowsePath);
  }
});

// Close modal on overlay click
document.getElementById("browse-overlay").addEventListener("click", () => {
  browseModal.style.display = "none";
});

toggleHiddenBtn.addEventListener("click", () => {
  showHidden = !showHidden;
  toggleHiddenBtn.classList.toggle("active", showHidden);
  loadTree();
});

// ---- Tree ----

async function loadTree() {
  if (!currentRoot) {
    treeEl.innerHTML = '<div class="loading">Select a root to browse</div>';
    return;
  }
  treeEl.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const res = await fetch(`/api/tree?path=${encodeURIComponent(currentRoot)}&showHidden=${showHidden}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load tree");
    treeData = data;
    renderTree();
  } catch (err) {
    treeEl.innerHTML = `<div class="loading" style="color:#f38ba8">${err.message}</div>`;
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
    if (browseModal.style.display === "flex") {
      browseModal.style.display = "none";
    } else if (document.activeElement === searchEl) {
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
