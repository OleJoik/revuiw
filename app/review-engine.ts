// Pure review-diff engine (no git, no I/O). Kept separate from the server so
// the core line-diff and approval-folding logic can be unit-tested directly.
//
// Model: three content snapshots — HEAD (baseline), reviewed (approved), and
// working (current). A working line is:
//   unchanged  — equal to HEAD
//   reviewed   — differs from HEAD but matches the reviewed snapshot
//   unreviewed — differs from the reviewed snapshot (needs approval)

export type LineStatus = "unchanged" | "reviewed" | "unreviewed";

export interface ReviewHunk {
  startLine: number; // 1-indexed inclusive
  endLine: number;   // 1-indexed inclusive
}

export interface ReviewState {
  tracked: boolean;
  changed: boolean;
  fullyReviewed: boolean;
  lineStatus: LineStatus[];
  hunks: ReviewHunk[];
  unreviewedLineCount: number;
  reviewedLineCount: number;
}

export interface Seg { type: "equal" | "change"; a: string[]; b: string[] }

// Split file content into logical lines, dropping the single trailing empty
// entry produced by a terminating newline. Mirrors the Viewer's splitLines so
// per-line indices line up exactly.
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

  // Merge adjacent same-type segments, drop empties.
  const out: Seg[] = [];
  for (const s of segs) {
    if (!s.a.length && !s.b.length) continue;
    const last = out[out.length - 1];
    if (last && last.type === s.type) { last.a.push(...s.a); last.b.push(...s.b); }
    else out.push({ type: s.type, a: [...s.a], b: [...s.b] });
  }
  return out;
}

function collectChangedB(segs: Seg[], set: Set<number>): void {
  let bi = 0;
  for (const s of segs) {
    if (s.type === "change") for (let k = 0; k < s.b.length; k++) set.add(bi + k);
    bi += s.b.length;
  }
}

function unreviewedRanges(segs: Seg[]): ReviewHunk[] {
  const ranges: ReviewHunk[] = [];
  let bi = 0;
  for (const s of segs) {
    if (s.type === "change" && s.b.length > 0) ranges.push({ startLine: bi + 1, endLine: bi + s.b.length });
    bi += s.b.length;
  }
  return ranges;
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Compute the full review overlay for a file from raw content snapshots.
// `head` is null when the file is untracked (no HEAD version).
export function computeReviewFromContent(head: string | null, reviewedContent: string, workingContent: string): ReviewState {
  const W = splitContentLines(workingContent);
  const H = splitContentLines(head ?? "");
  const R = splitContentLines(reviewedContent);

  const unreviewed = new Set<number>();
  const changed = new Set<number>();
  const segsRW = diffSegments(R, W);
  collectChangedB(segsRW, unreviewed);
  collectChangedB(diffSegments(H, W), changed);

  const lineStatus: LineStatus[] = W.map((_, i) =>
    unreviewed.has(i) ? "unreviewed" : (changed.has(i) ? "reviewed" : "unchanged"),
  );

  let reviewedLineCount = 0;
  for (const i of changed) if (!unreviewed.has(i)) reviewedLineCount++;

  return {
    tracked: head !== null,
    changed: !linesEqual(H, W),
    fullyReviewed: unreviewed.size === 0,
    lineStatus,
    hunks: unreviewedRanges(segsRW),
    unreviewedLineCount: unreviewed.size,
    reviewedLineCount,
  };
}

export interface FoldOptions { all?: boolean; startLine?: number; endLine?: number; reviewed: boolean }

// Produce the new reviewed-snapshot content for an approve-range operation.
// Approval is line-by-line: within a change block, each working line in
// [startLine, endLine] is folded onto the reviewed side individually, while the
// rest of the block stays unreviewed. A working line that is approved is written
// into the reviewed snapshot (so it re-derives as `reviewed`); an unapproved one
// is omitted (stays `unreviewed`). The old reviewed lines (s.a) are preserved
// once, just before the first unapproved line in the block, so the unapproved
// region still diffs. If every working line in the block is approved the old
// lines vanish (whole block approved); a pure deletion (no working lines) keeps
// its old lines since there is nothing to approve.
export function foldReviewedRange(reviewedContent: string, workingContent: string, opts: FoldOptions): string {
  const W = splitContentLines(workingContent);
  const R = splitContentLines(reviewedContent);
  const start = opts.startLine ?? 1;
  const end = opts.endLine ?? W.length;
  const approved = (lineNo: number) => opts.reviewed && lineNo >= start && lineNo <= end;

  const segs = diffSegments(R, W);
  const out: string[] = [];
  let bi = 0; // 0-based working line index
  for (const s of segs) {
    if (s.type === "equal") { out.push(...s.b); bi += s.b.length; continue; }
    let keptOld = false;
    for (let k = 0; k < s.b.length; k++) {
      if (approved(bi + k + 1)) {
        out.push(s.b[k]);
      } else if (!keptOld) {
        out.push(...s.a);
        keptOld = true;
      }
    }
    if (s.b.length === 0 && !keptOld) out.push(...s.a);
    bi += s.b.length;
  }
  return out.join("\n");
}
