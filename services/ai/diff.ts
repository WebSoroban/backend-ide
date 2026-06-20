/**
 * Dependency-free line diff for the diff-review UI.
 *
 * Produces a unified-diff string for display AND a structured hunk list with
 * stable ids so the frontend can accept/reject individual hunks. `applyHunks`
 * reconstructs the final file content from the original + the set of accepted
 * hunks, which is how per-hunk "accept" actually writes the file.
 *
 * Line-based LCS (good for source files); not a binary/character differ.
 */

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** hunk index this line belongs to (only set for add/del lines) */
  hunk?: number;
}

export interface Hunk {
  id: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  // Drop the trailing empty element from a final newline so counts are stable.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Full op list across the entire file (no truncated context). */
function diffOps(a: string[], b: string[]): { type: DiffLineType; text: string }[] {
  const n = a.length;
  const m = b.length;
  // LCS DP table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: { type: DiffLineType; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

/** Group the op list into hunks (changed runs + up to `context` context lines). */
export function computeHunks(oldStr: string, newStr: string, context = 3): Hunk[] {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  const ops = diffOps(a, b);

  // Indices of ops that are changes (add/del).
  const changedIdx = ops.map((o, idx) => (o.type === 'context' ? -1 : idx)).filter((x) => x >= 0);
  if (changedIdx.length === 0) return [];

  // Merge changes that are within 2*context of each other into one hunk.
  const groups: [number, number][] = [];
  let start = changedIdx[0];
  let end = changedIdx[0];
  for (let k = 1; k < changedIdx.length; k++) {
    if (changedIdx[k] - end <= context * 2) {
      end = changedIdx[k];
    } else {
      groups.push([start, end]);
      start = changedIdx[k];
      end = changedIdx[k];
    }
  }
  groups.push([start, end]);

  const hunks: Hunk[] = [];
  // Track running line numbers in old/new files.
  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let ol = 0;
  let nl = 0;
  for (const op of ops) {
    oldLineAt.push(ol);
    newLineAt.push(nl);
    if (op.type !== 'add') ol++;
    if (op.type !== 'del') nl++;
  }

  groups.forEach(([gStart, gEnd], hunkId) => {
    const lo = Math.max(0, gStart - context);
    const hi = Math.min(ops.length - 1, gEnd + context);
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let idx = lo; idx <= hi; idx++) {
      const op = ops[idx];
      const line: DiffLine = { type: op.type, text: op.text };
      if (op.type !== 'context') line.hunk = hunkId;
      if (op.type !== 'add') oldCount++;
      if (op.type !== 'del') newCount++;
      lines.push(line);
    }
    const oldStart = oldLineAt[lo] + 1;
    const newStart = newLineAt[lo] + 1;
    hunks.push({
      id: hunkId,
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    });
  });

  return hunks;
}

/** Render a unified diff string (with ---/+++ headers) for display. */
export function unifiedDiff(path: string, oldStr: string, newStr: string, context = 3): string {
  const hunks = computeHunks(oldStr, newStr, context);
  if (hunks.length === 0) return '';
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      out.push(prefix + l.text);
    }
  }
  return out.join('\n');
}

/**
 * Reconstruct file content from the original + the accepted hunks.
 * `accepted` = 'all' to accept everything, or a list of hunk ids to apply (the
 * rest are reverted to the original). Used by per-hunk diff review.
 */
export function applyHunks(oldStr: string, newStr: string, accepted: number[] | 'all', context = 3): string {
  if (accepted === 'all') return newStr;
  const acceptedSet = new Set(accepted);
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  const ops = diffOps(a, b);

  // Recompute the same hunk grouping so op->hunk ids line up with computeHunks.
  const changedIdx = ops.map((o, idx) => (o.type === 'context' ? -1 : idx)).filter((x) => x >= 0);
  const opHunk = new Array(ops.length).fill(-1);
  if (changedIdx.length) {
    let start = changedIdx[0];
    let end = changedIdx[0];
    let hunkId = 0;
    const assign = (s: number, e: number, id: number) => {
      for (let k = s; k <= e; k++) if (ops[k].type !== 'context') opHunk[k] = id;
    };
    for (let k = 1; k < changedIdx.length; k++) {
      if (changedIdx[k] - end <= context * 2) {
        end = changedIdx[k];
      } else {
        assign(start, end, hunkId++);
        start = changedIdx[k];
        end = changedIdx[k];
      }
    }
    assign(start, end, hunkId);
  }

  const result: string[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    if (op.type === 'context') {
      result.push(op.text);
      continue;
    }
    const applied = acceptedSet.has(opHunk[idx]);
    if (op.type === 'add') {
      if (applied) result.push(op.text);
    } else {
      // del: keep the old line when the hunk is NOT applied (reverted).
      if (!applied) result.push(op.text);
    }
  }
  // Preserve a trailing newline if either side had one.
  const trailing = oldStr.endsWith('\n') || newStr.endsWith('\n') ? '\n' : '';
  return result.join('\n') + trailing;
}

export default { computeHunks, unifiedDiff, applyHunks };
