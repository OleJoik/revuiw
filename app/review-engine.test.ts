import { test, expect, describe } from "bun:test";
import {
  splitContentLines,
  diffSegments,
  computeReviewFromContent,
  foldReviewedRange,
} from "./review-engine";

describe("splitContentLines", () => {
  test("drops the single trailing newline entry", () => {
    expect(splitContentLines("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });
  test("keeps content without a trailing newline", () => {
    expect(splitContentLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });
  test("keeps interior blank lines, drops only the final terminator", () => {
    expect(splitContentLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
  test("empty string is a single empty line", () => {
    expect(splitContentLines("")).toEqual([""]);
  });
  test("a bare newline is a single empty line", () => {
    expect(splitContentLines("\n")).toEqual([""]);
  });
});

describe("diffSegments", () => {
  test("identical input is one equal segment", () => {
    const segs = diffSegments(["a", "b"], ["a", "b"]);
    expect(segs).toEqual([{ type: "equal", a: ["a", "b"], b: ["a", "b"] }]);
  });
  test("pure insertion in the middle", () => {
    const segs = diffSegments(["a", "c"], ["a", "b", "c"]);
    expect(segs).toEqual([
      { type: "equal", a: ["a"], b: ["a"] },
      { type: "change", a: [], b: ["b"] },
      { type: "equal", a: ["c"], b: ["c"] },
    ]);
  });
  test("pure deletion in the middle", () => {
    const segs = diffSegments(["a", "b", "c"], ["a", "c"]);
    expect(segs).toEqual([
      { type: "equal", a: ["a"], b: ["a"] },
      { type: "change", a: ["b"], b: [] },
      { type: "equal", a: ["c"], b: ["c"] },
    ]);
  });
  test("replacement is a single change segment carrying both sides", () => {
    const segs = diffSegments(["a", "b", "c"], ["a", "B", "c"]);
    expect(segs).toEqual([
      { type: "equal", a: ["a"], b: ["a"] },
      { type: "change", a: ["b"], b: ["B"] },
      { type: "equal", a: ["c"], b: ["c"] },
    ]);
  });
  test("empty to content is one change segment", () => {
    expect(diffSegments([], ["x", "y"])).toEqual([{ type: "change", a: [], b: ["x", "y"] }]);
  });
});

describe("computeReviewFromContent", () => {
  test("unchanged tracked file: everything reviewed, nothing pending", () => {
    const s = computeReviewFromContent("a\nb\nc\n", "a\nb\nc\n", "a\nb\nc\n");
    expect(s.tracked).toBe(true);
    expect(s.changed).toBe(false);
    expect(s.fullyReviewed).toBe(true);
    expect(s.lineStatus).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(s.unreviewedLineCount).toBe(0);
    expect(s.reviewedLineCount).toBe(0);
    expect(s.hunks).toEqual([]);
  });

  test("edit not yet approved is unreviewed", () => {
    // reviewed snapshot still equals HEAD
    const s = computeReviewFromContent("a\nb\nc\n", "a\nb\nc\n", "a\nB\nc\n");
    expect(s.changed).toBe(true);
    expect(s.fullyReviewed).toBe(false);
    expect(s.lineStatus).toEqual(["unchanged", "unreviewed", "unchanged"]);
    expect(s.unreviewedLineCount).toBe(1);
    expect(s.reviewedLineCount).toBe(0);
    expect(s.hunks).toEqual([{ startLine: 2, endLine: 2 }]);
  });

  test("approved edit (reviewed==working) shows as reviewed, not unchanged", () => {
    const s = computeReviewFromContent("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
    expect(s.changed).toBe(true);
    expect(s.fullyReviewed).toBe(true);
    expect(s.lineStatus).toEqual(["unchanged", "reviewed", "unchanged"]);
    expect(s.unreviewedLineCount).toBe(0);
    expect(s.reviewedLineCount).toBe(1);
    expect(s.hunks).toEqual([]);
  });

  test("partial: one line approved, a later fresh edit still pending", () => {
    // HEAD a/b/c ; reviewed approved line 2 (B) ; working further changed line 3 (C)
    const s = computeReviewFromContent("a\nb\nc\n", "a\nB\nc\n", "a\nB\nC\n");
    expect(s.lineStatus).toEqual(["unchanged", "reviewed", "unreviewed"]);
    expect(s.reviewedLineCount).toBe(1);
    expect(s.unreviewedLineCount).toBe(1);
    expect(s.fullyReviewed).toBe(false);
    expect(s.hunks).toEqual([{ startLine: 3, endLine: 3 }]);
  });

  test("re-editing an already-approved line invalidates it (content-pinned)", () => {
    // reviewed approved line 2 as B, but the agent changed it again to B2
    const s = computeReviewFromContent("a\nb\nc\n", "a\nB\nc\n", "a\nB2\nc\n");
    expect(s.lineStatus).toEqual(["unchanged", "unreviewed", "unchanged"]);
    expect(s.fullyReviewed).toBe(false);
    expect(s.unreviewedLineCount).toBe(1);
  });

  test("untracked file (no HEAD): all lines pending, tracked=false", () => {
    const s = computeReviewFromContent(null, "", "x\ny\n");
    expect(s.tracked).toBe(false);
    expect(s.changed).toBe(true);
    expect(s.fullyReviewed).toBe(false);
    expect(s.lineStatus).toEqual(["unreviewed", "unreviewed"]);
    expect(s.unreviewedLineCount).toBe(2);
    expect(s.hunks).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  test("multi-line insertion produces one contiguous hunk", () => {
    const s = computeReviewFromContent("a\nd\n", "a\nd\n", "a\nb\nc\nd\n");
    expect(s.lineStatus).toEqual(["unchanged", "unreviewed", "unreviewed", "unchanged"]);
    expect(s.hunks).toEqual([{ startLine: 2, endLine: 3 }]);
  });
});

describe("foldReviewedRange", () => {
  const norm = (s: string) => splitContentLines(s);

  test("approving the exact changed line folds working onto reviewed", () => {
    const next = foldReviewedRange("a\nb\nc\n", "a\nB\nc\n", { reviewed: true, startLine: 2, endLine: 2 });
    expect(norm(next)).toEqual(["a", "B", "c"]);
  });

  test("approving one hunk leaves a non-intersecting hunk unreviewed", () => {
    // two separate changes: line 1 (a->A) and line 3 (c->C); approve only line 1
    const next = foldReviewedRange("a\nb\nc\n", "A\nb\nC\n", { reviewed: true, startLine: 1, endLine: 1 });
    expect(norm(next)).toEqual(["A", "b", "c"]);

    // feed the new reviewed snapshot back: line 1 now clean, line 3 still pending
    const s = computeReviewFromContent("a\nb\nc\n", next, "A\nb\nC\n");
    expect(s.lineStatus).toEqual(["reviewed", "unchanged", "unreviewed"]);
    expect(s.unreviewedLineCount).toBe(1);
  });

  test("approving a full range reproduces the working content", () => {
    const working = "A\nb\nC\n";
    const next = foldReviewedRange("a\nb\nc\n", working, { reviewed: true, startLine: 1, endLine: 3 });
    expect(norm(next)).toEqual(norm(working));
    const s = computeReviewFromContent("a\nb\nc\n", next, working);
    expect(s.fullyReviewed).toBe(true);
  });

  test("line-by-line: approving one line of a multi-line insertion leaves the rest pending", () => {
    // one 2-line insertion at working lines 2..3; approve only line 2
    const next = foldReviewedRange("a\nd\n", "a\nB\nC\nd\n", { reviewed: true, startLine: 2, endLine: 2 });
    expect(norm(next)).toEqual(["a", "B", "d"]);
    const s = computeReviewFromContent("a\nd\n", next, "a\nB\nC\nd\n");
    expect(s.lineStatus).toEqual(["unchanged", "reviewed", "unreviewed", "unchanged"]);
    expect(s.fullyReviewed).toBe(false);
  });

  test("line-by-line: approving one line of a multi-line replacement leaves the rest pending", () => {
    // reviewed p/q replaced by working P/Q/R (lines 1..3); approve only line 2
    const next = foldReviewedRange("p\nq\n", "P\nQ\nR\n", { reviewed: true, startLine: 2, endLine: 2 });
    const s = computeReviewFromContent("p\nq\n", next, "P\nQ\nR\n");
    expect(s.lineStatus).toEqual(["unreviewed", "reviewed", "unreviewed"]);
    expect(s.reviewedLineCount).toBe(1);
    expect(s.unreviewedLineCount).toBe(2);
  });

  test("line-by-line: approving the remaining lines later converges to working", () => {
    const head = "a\nd\n";
    const working = "a\nB\nC\nd\n";
    // step 1: approve only line 2
    let reviewed = foldReviewedRange(head, working, { reviewed: true, startLine: 2, endLine: 2 });
    // step 2: approve the still-pending line 3
    reviewed = foldReviewedRange(reviewed, working, { reviewed: true, startLine: 3, endLine: 3 });
    expect(norm(reviewed)).toEqual(norm(working));
    expect(computeReviewFromContent(head, reviewed, working).fullyReviewed).toBe(true);
  });

  test("a pure deletion is never approved by a range fold (nothing to select)", () => {
    // reviewed a/x/b, working a/b (line x deleted): approving line 1..2 keeps x in reviewed
    const next = foldReviewedRange("a\nx\nb\n", "a\nb\n", { reviewed: true, startLine: 1, endLine: 2 });
    expect(norm(next)).toEqual(["a", "x", "b"]);
  });

  test("reviewed:false is a no-op fold (keeps reviewed side)", () => {
    const next = foldReviewedRange("a\nb\nc\n", "a\nB\nc\n", { reviewed: false, startLine: 2, endLine: 2 });
    expect(norm(next)).toEqual(["a", "b", "c"]);
  });
});
