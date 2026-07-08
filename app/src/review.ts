// Review state: the per-line approval overlay for a file.
//
// The server compares three trees — HEAD (baseline), the reviewed snapshot
// (what you approved), and the working tree (current file) — and reports a
// status per working-tree line:
//   unchanged  — identical to HEAD, nothing to review
//   reviewed   — changed from HEAD but matches what you approved (green)
//   unreviewed — differs from what you approved; needs your control (yellow)
//
// Approval is content-pinned: any later edit (human or agent) reappears as
// unreviewed automatically, because the server just re-diffs the content.

export type LineStatus = "unchanged" | "reviewed" | "unreviewed";

export interface ReviewHunk {
  startLine: number; // 1-indexed, inclusive
  endLine: number;   // 1-indexed, inclusive
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

export interface ReviewSummary {
  files: Record<string, { changed: boolean; fullyReviewed: boolean; unreviewedLineCount: number }>;
}

export async function getReview(path: string): Promise<ReviewState | null> {
  try {
    const res = await fetch(`/api/review?path=${encodeURIComponent(path)}`);
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export interface MarkArgs {
  path: string;
  all?: boolean;
  startLine?: number;
  endLine?: number;
  reviewed?: boolean; // defaults to true
}

export async function markReview(args: MarkArgs): Promise<ReviewState | null> {
  try {
    const res = await fetch("/api/review/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export async function getReviewSummary(root: string): Promise<ReviewSummary> {
  try {
    const res = await fetch(`/api/review/summary?root=${encodeURIComponent(root)}`);
    return res.ok ? res.json() : { files: {} };
  } catch {
    return { files: {} };
  }
}

// Does the given working-tree line (1-indexed) fall inside an unreviewed hunk?
export function hunkAt(hunks: ReviewHunk[], line: number): ReviewHunk | null {
  return hunks.find(h => h.startLine <= line && line <= h.endLine) ?? null;
}
