let treeData = null;
let expanded = new Set();
let selectedPath = null;
let searchQuery = "";

const treeEl = document.getElementById("tree");
const searchEl = document.getElementById("search");
const placeholderEl = document.getElementById("viewer-placeholder");
const viewerContentEl = document.getElementById("viewer-content");
const viewerPathEl = document.getElementById("viewer-path");
const viewerBodyEl = document.getElementById("viewer-body");
const viewerCloseEl = document.getElementById("viewer-close");

async function loadTree() {
  treeEl.innerHTML = '<div class="loading">Loading...</div>';
  const res = await fetch("/api/tree?path=.");
  treeData = await res.json();
  expanded = new Set();
  renderTree();
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
    for (const child of node.children) {
      count += countMatches(child, query);
    }
  }
  return count;
}

function toggleExpand(path) {
  if (expanded.has(path)) {
    expanded.delete(path);
  } else {
    expanded.add(path);
  }
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

  const res = await fetch(`/api/read?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  viewerBodyEl.textContent = data.content;
}

viewerCloseEl.addEventListener("click", () => {
  selectedPath = null;
  placeholderEl.style.display = "flex";
  viewerContentEl.style.display = "none";
  renderTree();
});

function renderNode(node, parent, depth, isRoot) {
  const nodePath = isRoot ? "." : node.path;
  const isDir = node.type === "directory";
  const isOpen = expanded.has(nodePath);

  let matchCount = 0;
  let nodeMatches = false;
  if (searchQuery) {
    matchCount = countMatches(node, searchQuery);
    nodeMatches = node.name.toLowerCase().includes(searchQuery);
  }

  const hasSearch = searchQuery.length > 0;
  const show = !hasSearch || matchCount > 0;
  if (!show) return;

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
  label.textContent = node.name;

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
    }
  }

  row.appendChild(label);

  if (hasSearch && matchCount > 1) {
    const badge = document.createElement("span");
    badge.className = "match-count";
    badge.textContent = matchCount;
    row.appendChild(badge);
  }

  row.addEventListener("click", () => {
    if (isDir) {
      toggleExpand(nodePath);
    } else {
      selectFile(nodePath);
    }
  });

  parent.appendChild(row);

  if (isDir && isOpen && node.children) {
    for (const child of node.children) {
      renderNode(child, parent, depth + 1, false);
    }
  }
}

let searchTimer = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchEl.value.trim().toLowerCase();
    renderTree();
  }, 150);
});

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

loadTree();
