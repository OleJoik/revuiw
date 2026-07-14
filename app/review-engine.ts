// Pure review/diff engine (no git, no I/O). Kept separate from the server so
// the core line-diff, row-building and index-reconstruction logic can be
// unit-tested directly.
//
// Model (git-native): three content snapshots —
//   HEAD    = baseline (last commit)
//   index   = the staged tree = what has been "reviewed"
//   working = the current file on disk
//
// The review view is the HEAD -> working diff, split into rows. Each changed
// row is classified against the index:
//   reviewed   = the change is staged (present in the index)   [green]
//   unreviewed = the change is only in the working tree         [yellow]
// "Mark reviewed" == stage those lines; "unmark" == unstage them. The index is
// reconstructed from the rows and written back with git plumbing by the server.

export type RowKind = "context" | "add" | "del";
export type RowReview = "reviewed" | "unreviewed" | null;

export interface DiffRow {
  kind: RowKind;
  oldLine: number | null; // 1-indexed line in HEAD (null for pure additions)
  newLine: number | null; // 1-indexed line in working (null for deletions)
  content: string;
  review: RowReview;      // null for context rows
}

export interface DiffSummary {
  changed: boolean;
  fullyReviewed: boolean;
  reviewedRows: number;
  unreviewedRows: number;
}

export interface Seg { type: "equal" | "change"; a: string[]; b: string[] }

// Split file content into logical lines, dropping the single trailing empty
// entry produced by a terminating newline.
export function splitContentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const DIFF_CELL_CAP = 1_000_000; // skip fine-grained LCS above this a*b size

function lcsSegments(a: string[], b: string[]): Seg[] {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: "change", a: [], b: [...b] }];
  if (m === 0) return [{ type: "change", a: [...a], b: [] }];
  if (n * m > DIFF_CELL_CAP) return [{ type: "change", a: [...a], b: [...b] }];

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const segs: Seg[] = [];
  const pushOp = (t: "eq" | "del" | "ins", line: string) => {
    const last = segs[segs.length - 1];
    if (t === "eq") {
      if (last && last.type === "equal") { last.a.push(line); last.b.push(line); }
      else segs.push({ type: "equal", a: [line], b: [line] });
    } else {
      let seg = last && last.type === "change" ? last : null;
      if (!seg) { seg = { type: "change", a: [], b: [] }; segs.push(seg); }
      if (t === "del") seg.a.push(line); else seg.b.push(line);
    }
  };

  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pushOp("eq", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { pushOp("del", a[i]); i++; }
    else { pushOp("ins", b[j]); j++; }
  }
  while (i < n) { pushOp("del", a[i]); i++; }
  while (j < m) { pushOp("ins", b[j]); j++; }
  return segs;
}

export function diffSegments(a: string[], b: string[]): Seg[] {
  let aStart = 0, aEnd = a.length, bStart = 0, bEnd = b.length;
  const prefix: string[] = [];
  while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) { prefix.push(a[aStart]); aStart++; bStart++; }
  const suffix: string[] = [];
  while (aEnd > aStart && bEnd > bStart && a[aEnd - 1] === b[bEnd - 1]) { suffix.unshift(a[aEnd - 1]); aEnd--; bEnd--; }

  const segs: Seg[] = [];
  if (prefix.length) segs.push({ type: "equal", a: prefix, b: prefix });
  for (const s of lcsSegments(a.slice(aStart, aEnd), b.slice(bStart, bEnd))) segs.push(s);
  if (suffix.length) segs.push({ type: "equal", a: suffix, b: suffix });

  const out: Seg[] = [];
  for (const s of segs) {
    if (!s.a.length && !s.b.length) continue;
    const last = out[out.length - 1];
    if (last && last.type === s.type) { last.a.push(...s.a); last.b.push(...s.b); }
    else out.push({ type: s.type, a: [...s.a], b: [...s.b] });
  }
  return out;
}

// Indices (0-based) of the B-side / A-side lines that fall in a change segment.
function changedBIndices(segs: Seg[]): Set<number> {
  const set = new Set<number>();
  let bi = 0;
  for (const s of segs) {
    if (s.type === "change") for (let k = 0; k < s.b.length; k++) set.add(bi + k);
    bi += s.b.length;
  }
  return set;
}

function changedAIndices(segs: Seg[]): Set<number> {
  const set = new Set<number>();
  let ai = 0;
  for (const s of segs) {
    if (s.type === "change") for (let k = 0; k < s.a.length; k++) set.add(ai + k);
    ai += s.a.length;
  }
  return set;
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Build the HEAD -> working diff as a row list, classifying each changed row
// reviewed/unreviewed via the index. `head`/`index` are null when there is no
// such tree (untracked file); callers pass "" to mean "empty tree".
export function computeDiffRows(head: string | null, index: string | null, working: string): DiffRow[] {
  // An absent tree (null) or the empty string means "no lines". This differs
  // from splitContentLines(""), which yields a single blank line (a file that
  // genuinely contains one empty line).
  const H = head ? splitContentLines(head) : [];
  const I = index ? splitContentLines(index) : [];
  const W = working ? splitContentLines(working) : [];

  // Working lines that differ from the index are unstaged (unreviewed adds).
  const unstagedW = changedBIndices(diffSegments(I, W));
  // HEAD lines absent/changed in the index are staged removals (reviewed dels).
  const stagedDelH = changedAIndices(diffSegments(H, I));

  const rows: DiffRow[] = [];
  let hi = 0, wi = 0; // 0-based line cursors into HEAD / working
  for (const s of diffSegments(H, W)) {
    if (s.type === "equal") {
      for (let k = 0; k < s.b.length; k++) {
        rows.push({ kind: "context", oldLine: hi + 1, newLine: wi + 1, content: s.b[k], review: null });
        hi++; wi++;
      }
      continue;
    }
    for (let k = 0; k < s.a.length; k++) {
      rows.push({ kind: "del", oldLine: hi + 1, newLine: null, content: s.a[k], review: stagedDelH.has(hi) ? "reviewed" : "unreviewed" });
      hi++;
    }
    for (let k = 0; k < s.b.length; k++) {
      rows.push({ kind: "add", oldLine: null, newLine: wi + 1, content: s.b[k], review: unstagedW.has(wi) ? "unreviewed" : "reviewed" });
      wi++;
    }
  }
  return rows;
}

export function summarize(rows: DiffRow[]): DiffSummary {
  let reviewedRows = 0, unreviewedRows = 0;
  for (const r of rows) {
    if (r.review === "reviewed") reviewedRows++;
    else if (r.review === "unreviewed") unreviewedRows++;
  }
  return {
    changed: reviewedRows + unreviewedRows > 0,
    fullyReviewed: unreviewedRows === 0,
    reviewedRows,
    unreviewedRows,
  };
}

// Reconstruct the index (staged) content implied by a set of rows:
//   context -> always present
//   add     -> present iff reviewed (staged)
//   del     -> present iff NOT reviewed (an unstaged deletion keeps the old line
//              in the index; a staged deletion drops it)
// `trailingNewline` controls whether the result ends in "\n" (mirrors working).
export function rebuildIndex(rows: DiffRow[], trailingNewline: boolean): string {
  const out: string[] = [];
  for (const r of rows) {
    if (r.kind === "context") out.push(r.content);
    else if (r.kind === "add") { if (r.review === "reviewed") out.push(r.content); }
    else if (r.review !== "reviewed") out.push(r.content);
  }
  if (out.length === 0) return "";
  return out.join("\n") + (trailingNewline ? "\n" : "");
}

// Return a copy of `rows` with the review flag flipped for the add/del rows in
// the inclusive row-index range [startRow, endRow] (context rows untouched).
export function toggleRows(rows: DiffRow[], startRow: number, endRow: number, reviewed: boolean): DiffRow[] {
  const status: RowReview = reviewed ? "reviewed" : "unreviewed";
  return rows.map((r, i) => {
    if (i < startRow || i > endRow || r.kind === "context") return r;
    return { ...r, review: status };
  });
}

export { linesEqual };
