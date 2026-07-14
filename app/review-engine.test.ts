import { test, expect, describe } from "bun:test";
import {
  splitContentLines,
  diffSegments,
  computeDiffRows,
  summarize,
  rebuildIndex,
  toggleRows,
  type DiffRow,
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

// Compact helper to describe a row: kind + content + review flag.
const desc = (rows: DiffRow[]) =>
  rows.map((r) => `${r.kind === "context" ? " " : r.kind === "add" ? "+" : "-"}${r.content}${r.review ? "(" + r.review[0] + ")" : ""}`);

describe("computeDiffRows", () => {
  test("unchanged tracked file: all context, nothing changed", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\nc\n", "a\nb\nc\n");
    expect(rows.every((r) => r.kind === "context")).toBe(true);
    expect(summarize(rows)).toEqual({ changed: false, fullyReviewed: true, reviewedRows: 0, unreviewedRows: 0 });
  });

  test("unstaged edit: replacement shows del+add, add unreviewed", () => {
    // HEAD==index (nothing staged), working changed line 2
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\nc\n", "a\nB\nc\n");
    expect(desc(rows)).toEqual([" a", "-b(u)", "+B(u)", " c"]);
    expect(summarize(rows)).toMatchObject({ changed: true, fullyReviewed: false, unreviewedRows: 2 });
  });

  test("staged edit: index==working, change is reviewed", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
    expect(desc(rows)).toEqual([" a", "-b(r)", "+B(r)", " c"]);
    expect(summarize(rows)).toMatchObject({ fullyReviewed: true, reviewedRows: 2, unreviewedRows: 0 });
  });

  test("partial: one line staged, a later fresh edit still unstaged", () => {
    // HEAD a/b/c ; index staged line 2 (B) ; working further edits line 3 (C)
    const rows = computeDiffRows("a\nb\nc\n", "a\nB\nc\n", "a\nB\nC\n");
    expect(desc(rows)).toEqual([" a", "-b(r)", "-c(u)", "+B(r)", "+C(u)"]);
    expect(summarize(rows)).toMatchObject({ reviewedRows: 2, unreviewedRows: 2 });
  });

  test("untracked file (head empty): all additions unreviewed", () => {
    const rows = computeDiffRows("", "", "x\ny\n");
    expect(desc(rows)).toEqual(["+x(u)", "+y(u)"]);
    expect(summarize(rows)).toMatchObject({ changed: true, fullyReviewed: false, unreviewedRows: 2 });
  });

  test("staged deletion: HEAD line dropped in index -> del reviewed", () => {
    // HEAD a/x/b ; index a/b (x staged for removal) ; working a/b
    const rows = computeDiffRows("a\nx\nb\n", "a\nb\n", "a\nb\n");
    expect(desc(rows)).toEqual([" a", "-x(r)", " b"]);
    expect(summarize(rows)).toMatchObject({ fullyReviewed: true, reviewedRows: 1 });
  });

  test("unstaged deletion: HEAD line still in index -> del unreviewed", () => {
    const rows = computeDiffRows("a\nx\nb\n", "a\nx\nb\n", "a\nb\n");
    expect(desc(rows)).toEqual([" a", "-x(u)", " b"]);
    expect(summarize(rows)).toMatchObject({ fullyReviewed: false, unreviewedRows: 1 });
  });

  test("line numbers track HEAD (old) and working (new)", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\nc\n", "a\nB\nc\n");
    expect(rows.map((r) => [r.oldLine, r.newLine])).toEqual([
      [1, 1],   // context a
      [2, null], // del b
      [null, 2], // add B
      [3, 3],   // context c
    ]);
  });
});

describe("rebuildIndex", () => {
  test("reviewed add is kept, unreviewed add is dropped", () => {
    const rows = computeDiffRows("a\nc\n", "a\nc\n", "a\nb\nc\n"); // add b unreviewed
    expect(rebuildIndex(rows, true)).toBe("a\nc\n");
    const staged = toggleRows(rows, 0, rows.length - 1, true);
    expect(rebuildIndex(staged, true)).toBe("a\nb\nc\n");
  });

  test("reviewed del drops the line, unreviewed del keeps it", () => {
    const rows = computeDiffRows("a\nx\nb\n", "a\nx\nb\n", "a\nb\n"); // del x unreviewed
    expect(rebuildIndex(rows, true)).toBe("a\nx\nb\n");
    const staged = toggleRows(rows, 0, rows.length - 1, true);
    expect(rebuildIndex(staged, true)).toBe("a\nb\n");
  });

  test("no trailing newline is respected", () => {
    const rows = computeDiffRows("a\n", "a\n", "a\nb");
    const staged = toggleRows(rows, 0, rows.length - 1, true);
    expect(rebuildIndex(staged, false)).toBe("a\nb");
  });

  test("empty result yields empty string", () => {
    const rows = computeDiffRows("a\n", "a\n", ""); // del a
    const staged = toggleRows(rows, 0, rows.length - 1, true);
    expect(rebuildIndex(staged, false)).toBe("");
  });
});

describe("toggleRows", () => {
  test("staging one row of a two-line insertion leaves the other unstaged", () => {
    const rows = computeDiffRows("a\nd\n", "a\nd\n", "a\nb\nc\nd\n");
    // rows: context a, add b, add c, context d -> stage only row 1 (b)
    const staged = toggleRows(rows, 1, 1, true);
    expect(rebuildIndex(staged, true)).toBe("a\nb\nd\n");
    expect(summarize(staged)).toMatchObject({ reviewedRows: 1, unreviewedRows: 1 });
  });

  test("context rows are never flipped", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\n", "a\nB\n");
    const staged = toggleRows(rows, 0, rows.length - 1, true);
    expect(staged[0].review).toBe(null); // context a stays null
  });

  test("unstaging (reviewed:false) marks rows unreviewed", () => {
    const rows = computeDiffRows("a\nb\n", "a\nB\n", "a\nB\n"); // staged
    const unstaged = toggleRows(rows, 0, rows.length - 1, false);
    expect(summarize(unstaged)).toMatchObject({ reviewedRows: 0, unreviewedRows: 2 });
  });
});
