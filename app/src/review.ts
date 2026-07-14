// Review state: the git-native diff view for a file.
//
// The server reports the HEAD -> working diff as a list of rows. Each changed
// row is classified against the git index (the staged tree):
//   reviewed   — the change is staged (green)
//   unreviewed — the change is only in the working tree (yellow)
// "Mark reviewed" stages the selected rows, "unmark" unstages them. Because the
// index IS the reviewed set, committing later commits exactly what was reviewed.

export type RowKind = "context" | "add" | "del";
export type RowReview = "reviewed" | "unreviewed" | null;

export interface Token {
  content: string;
  color: string;
}

export interface DiffRow {
  kind: RowKind;
  oldLine: number | null; // 1-indexed line in HEAD (null for pure additions)
  newLine: number | null; // 1-indexed line in working (null for deletions)
  content: string;
  review: RowReview;      // null for context rows
  tokens: Token[] | null; // highlighted tokens for this row (may be null)
}

export interface ReviewState {
  inRepo: boolean;
  lang: string | null;
  rows: DiffRow[];
  changed: boolean;
  fullyReviewed: boolean;
  reviewedRows: number;
  unreviewedRows: number;
}

export interface ReviewSummary {
  files: Record<string, { changed: boolean; fullyReviewed: boolean; unreviewedRows: number }>;
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
  startRow?: number; // inclusive row index into ReviewState.rows
  endRow?: number;   // inclusive row index into ReviewState.rows
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
