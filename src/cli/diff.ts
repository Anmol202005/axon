// ===========================================================================
// diff — minimal line-based unified diff used by the approval UI
// ===========================================================================
//
// Strategy: LCS table for line equality. O(m·n) time/space. For typical
// agent writes (hundreds of lines) this is fine. For very large files we
// fall back to a non-diff "replace whole file" view so the table doesn't
// balloon.
//
// We intentionally avoid pulling in a diff library — this stays a small,
// dependency-free helper that produces a structured representation the
// renderer can colorize.

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  // 1-indexed line numbers; null when the line doesn't exist on that side.
  oldLineNo: number | null;
  newLineNo: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface DiffResult {
  lines: DiffLine[];
  stats: DiffStats;
  // True when we bailed out of the LCS pass because the input was too big.
  truncated: boolean;
}

const MAX_LCS_LINES = 4000;

export function lineDiff(oldText: string, newText: string): DiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES) {
    return naiveReplace(oldLines, newLines, true);
  }

  const m = oldLines.length;
  const n = newLines.length;
  // lcs[i][j] = length of LCS of oldLines[i..] and newLines[j..]
  const lcs: Uint32Array[] = Array.from(
    { length: m + 1 },
    () => new Uint32Array(n + 1),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const out: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      out.push({
        kind: "ctx",
        text: oldLines[i],
        oldLineNo: i + 1,
        newLineNo: j + 1,
      });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({
        kind: "del",
        text: oldLines[i],
        oldLineNo: i + 1,
        newLineNo: null,
      });
      removed++;
      i++;
    } else {
      out.push({
        kind: "add",
        text: newLines[j],
        oldLineNo: null,
        newLineNo: j + 1,
      });
      added++;
      j++;
    }
  }
  while (i < m) {
    out.push({
      kind: "del",
      text: oldLines[i],
      oldLineNo: i + 1,
      newLineNo: null,
    });
    removed++;
    i++;
  }
  while (j < n) {
    out.push({
      kind: "add",
      text: newLines[j],
      oldLineNo: null,
      newLineNo: j + 1,
    });
    added++;
    j++;
  }
  return { lines: out, stats: { added, removed }, truncated: false };
}

function naiveReplace(
  oldLines: string[],
  newLines: string[],
  truncated: boolean,
): DiffResult {
  const out: DiffLine[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    out.push({
      kind: "del",
      text: oldLines[i],
      oldLineNo: i + 1,
      newLineNo: null,
    });
  }
  for (let j = 0; j < newLines.length; j++) {
    out.push({
      kind: "add",
      text: newLines[j],
      oldLineNo: null,
      newLineNo: j + 1,
    });
  }
  return {
    lines: out,
    stats: { added: newLines.length, removed: oldLines.length },
    truncated,
  };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

// ---------------------------------------------------------------------------
// trimToHunks — drop long runs of context lines so the preview stays terse.
// Keeps `padding` ctx lines around every change region; collapses the rest
// into a single placeholder line so the user still sees gaps were elided.
// ---------------------------------------------------------------------------

export interface TrimmedDiff {
  lines: (DiffLine | { kind: "gap"; collapsed: number })[];
}

export function trimToHunks(diff: DiffResult, padding = 3): TrimmedDiff {
  const lines = diff.lines;
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "ctx") {
      for (
        let k = Math.max(0, i - padding);
        k <= Math.min(lines.length - 1, i + padding);
        k++
      ) {
        keep[k] = true;
      }
    }
  }
  const out: TrimmedDiff["lines"] = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (gap > 0) {
        out.push({ kind: "gap", collapsed: gap });
        gap = 0;
      }
      out.push(lines[i]);
    } else {
      gap++;
    }
  }
  // Trailing gap is dropped intentionally — no meaningful change follows it.
  return { lines: out };
}
