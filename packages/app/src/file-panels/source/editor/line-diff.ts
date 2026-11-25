/** A run of lines that differs between a base and a document; line indexes are 0-based, end-exclusive. */
export interface LineHunk {
  baseFrom: number;
  baseTo: number;
  docFrom: number;
  docTo: number;
}

/**
 * Edit distance past which `diffLines` stops searching. Myers keeps one snapshot of its frontier per
 * step, so memory grows with the square of this number: 1000 steps hold about 2 million integers.
 * A buffer that differs from its base by more than this many lines is not a small edit, and its
 * changed region is reported as one hunk instead.
 */
const MAX_EDIT_DISTANCE = 1000;

/**
 * Line hunks that turn `base` into `doc`, by Myers' O(ND) shortest edit script. The common prefix
 * and suffix are trimmed first, which is nearly all of a typical edit.
 */
export function diffLines(base: readonly string[], doc: readonly string[]): LineHunk[] {
  let prefix = 0;
  while (prefix < base.length && prefix < doc.length && base[prefix] === doc[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < doc.length - prefix &&
    base[base.length - 1 - suffix] === doc[doc.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const a = base.slice(prefix, base.length - suffix);
  const b = doc.slice(prefix, doc.length - suffix);
  if (a.length === 0 && b.length === 0) return [];
  const edits = shortestEdits(a, b);
  if (edits === null) {
    return [
      { baseFrom: prefix, baseTo: prefix + a.length, docFrom: prefix, docTo: prefix + b.length },
    ];
  }
  return hunksFromEdits(edits, a.length, b.length, prefix);
}

interface EditMarks {
  /** `deleted[i]`: base line i is not in the document. */
  deleted: boolean[];
  /** `inserted[j]`: document line j is not in the base. */
  inserted: boolean[];
}

function internLines(a: readonly string[], b: readonly string[]): [number[], number[]] {
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  return [a.map(intern), b.map(intern)];
}

/** Null when the edit distance exceeds MAX_EDIT_DISTANCE. */
function shortestEdits(
  baseLines: readonly string[],
  docLines: readonly string[],
): EditMarks | null {
  const [a, b] = internLines(baseLines, docLines);
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      const index = k + offset;
      let x =
        k === -d || (k !== d && frontier[index - 1] < frontier[index + 1])
          ? frontier[index + 1]
          : frontier[index - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[index] = x;
      if (x >= n && y >= m) return backtrack({ trace, offset, distance: d, n, m });
    }
  }
  return null;
}

function backtrack(input: {
  trace: Int32Array[];
  offset: number;
  distance: number;
  n: number;
  m: number;
}): EditMarks {
  const { trace, offset, n, m } = input;
  const marks: EditMarks = {
    deleted: Array.from({ length: n }, () => false),
    inserted: Array.from({ length: m }, () => false),
  };
  let x = n;
  let y = m;
  for (let d = input.distance; d > 0; d -= 1) {
    const before = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && before[k - 1 + offset] < before[k + 1 + offset]);
    const previousK = down ? k + 1 : k - 1;
    const previousX = before[previousK + offset];
    const previousY = previousX - previousK;
    const startX = down ? previousX : previousX + 1;
    const startY = down ? previousY + 1 : previousY;
    while (x > startX && y > startY) {
      x -= 1;
      y -= 1;
    }
    if (down) marks.inserted[y - 1] = true;
    else marks.deleted[x - 1] = true;
    x = previousX;
    y = previousY;
  }
  return marks;
}

function hunksFromEdits(marks: EditMarks, n: number, m: number, offset: number): LineHunk[] {
  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && !marks.deleted[i] && j < m && !marks.inserted[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const baseFrom = i;
    const docFrom = j;
    while (i < n && marks.deleted[i]) i += 1;
    while (j < m && marks.inserted[j]) j += 1;
    hunks.push({
      baseFrom: baseFrom + offset,
      baseTo: i + offset,
      docFrom: docFrom + offset,
      docTo: j + offset,
    });
  }
  return hunks;
}
