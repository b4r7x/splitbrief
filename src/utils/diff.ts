const LARGE_FILE_THRESHOLD = 5000;

export function computeDiff(
  oldContent: string,
  newContent: string,
): { diff: string; linesAdded: number; linesRemoved: number } {
  if (oldContent === newContent) return { diff: '', linesAdded: 0, linesRemoved: 0 };

  const oldLines = oldContent === '' ? [] : oldContent.split('\n');
  const newLines = newContent === '' ? [] : newContent.split('\n');

  if (oldLines.length === 0) {
    return {
      diff: newLines.map((l) => `+ ${l}`).join('\n'),
      linesAdded: newLines.length,
      linesRemoved: 0,
    };
  }
  if (newLines.length === 0) {
    return {
      diff: oldLines.map((l) => `- ${l}`).join('\n'),
      linesAdded: 0,
      linesRemoved: oldLines.length,
    };
  }

  // Files > 5000 lines: classic LCS DP is O(m×n) time AND memory; fall back to positional diff
  if (oldLines.length > LARGE_FILE_THRESHOLD || newLines.length > LARGE_FILE_THRESHOLD) {
    return diffLinesSimple(oldLines, newLines);
  }

  const changes = diffLines(oldLines, newLines);
  return formatWithContext(changes, 2);
}

function diffLinesSimple(
  oldLines: string[],
  newLines: string[],
): { diff: string; linesAdded: number; linesRemoved: number } {
  const changes: Change[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    if (oldLine !== undefined && oldLine === newLine) {
      changes.push({ type: ' ', line: oldLine });
    } else {
      if (oldLine !== undefined) changes.push({ type: '-', line: oldLine });
      if (newLine !== undefined) changes.push({ type: '+', line: newLine });
    }
  }
  return formatWithContext(changes, 2);
}

type Change = { type: '+' | '-' | ' '; line: string };

function diffLines(oldLines: string[], newLines: string[]): Change[] {
  const m = oldLines.length;
  const n = newLines.length;

  const stride = n + 1;
  const dp = new Int32Array((m + 1) * stride);
  const lookup = (i: number, j: number): number => dp[i * stride + j] ?? 0;
  for (let i = 1; i <= m; i++) {
    const oi = oldLines[i - 1] ?? '';
    for (let j = 1; j <= n; j++) {
      const nj = newLines[j - 1] ?? '';
      dp[i * stride + j] =
        oi === nj ? lookup(i - 1, j - 1) + 1 : Math.max(lookup(i - 1, j), lookup(i, j - 1));
    }
  }

  const changes: Change[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    const oi = i > 0 ? (oldLines[i - 1] ?? '') : '';
    const nj = j > 0 ? (newLines[j - 1] ?? '') : '';
    if (i > 0 && j > 0 && oi === nj) {
      changes.push({ type: ' ', line: oi });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lookup(i, j - 1) >= lookup(i - 1, j))) {
      changes.push({ type: '+', line: nj });
      j--;
    } else {
      changes.push({ type: '-', line: oi });
      i--;
    }
  }

  return changes.reverse();
}

function formatWithContext(
  changes: Change[],
  contextLines: number,
): { diff: string; linesAdded: number; linesRemoved: number } {
  const changed = new Set<number>();
  changes.forEach((ch, i) => {
    if (ch.type !== ' ') changed.add(i);
  });

  if (changed.size === 0) return { diff: '', linesAdded: 0, linesRemoved: 0 };

  const included = new Set<number>();
  for (const idx of changed) {
    for (
      let c = Math.max(0, idx - contextLines);
      c <= Math.min(changes.length - 1, idx + contextLines);
      c++
    ) {
      included.add(c);
    }
  }

  let linesAdded = 0;
  let linesRemoved = 0;
  for (const ch of changes) {
    if (ch.type === '+') linesAdded++;
    if (ch.type === '-') linesRemoved++;
  }

  const lines: string[] = [];
  changes.forEach((ch, i) => {
    if (included.has(i)) lines.push(`${ch.type} ${ch.line}`);
  });

  return { diff: lines.join('\n'), linesAdded, linesRemoved };
}
