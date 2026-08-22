/**
 * A line diff, written rather than installed.
 *
 * The `diff` package would do this, but this CLI ships five dependencies and
 * `npm i -g` is the pitch. Sixty lines of well-understood algorithm is a better
 * trade than a sixth entry in package.json.
 *
 * Two things make it fast enough on real files without being clever:
 *
 *   1. Common prefix and suffix are trimmed first. An edit almost always touches
 *      a small part of a file, so this usually collapses a 2,000-line file to
 *      the twenty lines that changed.
 *   2. The remaining middle goes through an LCS table, which is O(n·m) in time
 *      and memory. That is fine for twenty lines and ruinous for twenty
 *      thousand, so past a threshold it degrades to "this block was replaced"
 *      rather than trying and running out of memory.
 */

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  /** Line number in the OLD file, when this line exists there. */
  oldNo?: number;
  /** Line number in the NEW file, when this line exists there. */
  newNo?: number;
  text: string;
}

export interface DiffHunk {
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the middle was too large to diff properly and was replaced whole. */
  coarse: boolean;
}

/** Past this many changed lines on either side, stop trying to be precise. */
const LCS_LIMIT = 2_500;

/** Longest common subsequence of two line arrays, as a list of index pairs. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  // One row at a time would be enough for the LENGTH, but the pairs need the
  // full table to walk back through. This is the part that is bounded above.
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Diff two files by line, returning hunks with `context` unchanged lines around
 * each change — the same shape `git diff -U<n>` produces, because that is what
 * anyone reading a diff in a terminal already knows how to read.
 */
export function diffLines(oldText: string, newText: string, context = 3): FileDiff {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  // Trim the identical head and tail. Everything outside is context by definition.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const all: DiffLine[] = [];
  const push = (kind: DiffLine["kind"], text: string, oldNo?: number, newNo?: number) =>
    all.push({ kind, text, oldNo, newNo });

  for (let i = 0; i < head; i++) push("ctx", a[i], i + 1, i + 1);

  let added = 0;
  let removed = 0;
  let coarse = false;

  if (midA.length > LCS_LIMIT || midB.length > LCS_LIMIT) {
    // Too big to align line by line. Say what happened rather than guess at it.
    coarse = true;
    midA.forEach((t, i) => push("del", t, head + i + 1));
    midB.forEach((t, i) => push("add", t, undefined, head + i + 1));
    removed += midA.length;
    added += midB.length;
  } else {
    const pairs = lcsPairs(midA, midB);
    let ai = 0;
    let bi = 0;
    const emitUpTo = (ea: number, eb: number) => {
      while (ai < ea) {
        push("del", midA[ai], head + ai + 1);
        removed++;
        ai++;
      }
      while (bi < eb) {
        push("add", midB[bi], undefined, head + bi + 1);
        added++;
        bi++;
      }
    };
    for (const [pa, pb] of pairs) {
      emitUpTo(pa, pb);
      push("ctx", midA[ai], head + ai + 1, head + bi + 1);
      ai++;
      bi++;
    }
    emitUpTo(midA.length, midB.length);
  }

  for (let i = 0; i < tail; i++) {
    const ao = a.length - tail + i;
    const bo = b.length - tail + i;
    push("ctx", a[ao], ao + 1, bo + 1);
  }

  return { hunks: intoHunks(all, context), added, removed, coarse };
}

/** Group changes with `context` lines either side, dropping the untouched rest. */
function intoHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changed = lines.map((l) => l.kind !== "ctx");
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  }

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      current.push(lines[i]);
    } else if (current.length) {
      hunks.push({ lines: current });
      current = [];
    }
  }
  if (current.length) hunks.push({ lines: current });
  return hunks;
}
