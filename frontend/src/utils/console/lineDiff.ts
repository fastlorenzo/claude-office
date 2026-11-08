/** Small line diff for Edit/MultiEdit previews (old_string versus new_string). */

export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
}

export interface LineDiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when output was cut at `maxLines` or LCS was skipped for size. */
  truncated: boolean;
}

export interface LineDiffOptions {
  /** Maximum output lines (default 400). */
  maxLines?: number;
  /** Unchanged lines kept around the changed block (default 3). */
  context?: number;
  /** Above this many LCS cells the middle degrades to remove-all + add-all. */
  maxCells?: number;
}

/**
 * Diff two texts by lines: shared prefix/suffix trimmed (kept as context),
 * LCS on the middle. Both counts are exact unless the LCS was skipped.
 */
export function lineDiff(
  oldText: string,
  newText: string,
  opts: LineDiffOptions = {},
): LineDiffResult {
  const maxLines = opts.maxLines ?? 400;
  const context = opts.context ?? 3;
  const maxCells = opts.maxCells ?? 250_000;
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  let truncated = false;
  const mid: DiffLine[] = [];
  if (am.length * bm.length > maxCells) {
    truncated = true;
    for (const t of am) mid.push({ type: "del", text: t });
    for (const t of bm) mid.push({ type: "add", text: t });
  } else {
    const w = bm.length + 1;
    const dp = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        dp[i * w + j] =
          am[i] === bm[j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        mid.push({ type: "ctx", text: am[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        mid.push({ type: "del", text: am[i++] });
      } else {
        mid.push({ type: "add", text: bm[j++] });
      }
    }
    while (i < am.length) mid.push({ type: "del", text: am[i++] });
    while (j < bm.length) mid.push({ type: "add", text: bm[j++] });
  }

  const head = a.slice(Math.max(0, pre - context), pre);
  const tail = a.slice(a.length - suf, a.length - suf + context);
  let lines: DiffLine[] = [
    ...head.map((text): DiffLine => ({ type: "ctx", text })),
    ...mid,
    ...tail.map((text): DiffLine => ({ type: "ctx", text })),
  ];
  const added = mid.filter((l) => l.type === "add").length;
  const removed = mid.filter((l) => l.type === "del").length;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }
  return { lines, added, removed, truncated };
}
