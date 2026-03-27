export function computeDiff(oldContent: string, newContent: string): { diff: string; linesAdded: number; linesRemoved: number } {
  if (oldContent === newContent) return { diff: '', linesAdded: 0, linesRemoved: 0 };
  if (oldContent === '' && newContent === '') return { diff: '', linesAdded: 0, linesRemoved: 0 };

  const oldLines = oldContent === '' ? [] : oldContent.split('\n');
  const newLines = newContent === '' ? [] : newContent.split('\n');

  if (oldLines.length === 0) {
    return { diff: newLines.map(l => `+ ${l}`).join('\n'), linesAdded: newLines.length, linesRemoved: 0 };
  }
  if (newLines.length === 0) {
    return { diff: oldLines.map(l => `- ${l}`).join('\n'), linesAdded: 0, linesRemoved: oldLines.length };
  }

  const changes = diffLines(oldLines, newLines);
  return formatWithContext(changes, 2);
}

type Change = { type: '+' | '-' | ' '; line: string };

function diffLines(oldLines: string[], newLines: string[]): Change[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Myers-like LCS via DP to get edit script
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const changes: Change[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      changes.push({ type: ' ', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      changes.push({ type: '+', line: newLines[j - 1] });
      j--;
    } else {
      changes.push({ type: '-', line: oldLines[i - 1] });
      i--;
    }
  }

  return changes.reverse();
}

function formatWithContext(changes: Change[], contextLines: number): { diff: string; linesAdded: number; linesRemoved: number } {
  const changed = new Set<number>();
  for (let i = 0; i < changes.length; i++) {
    if (changes[i].type !== ' ') changed.add(i);
  }

  if (changed.size === 0) return { diff: '', linesAdded: 0, linesRemoved: 0 };

  const included = new Set<number>();
  for (const idx of changed) {
    for (let c = Math.max(0, idx - contextLines); c <= Math.min(changes.length - 1, idx + contextLines); c++) {
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
  for (let i = 0; i < changes.length; i++) {
    if (!included.has(i)) continue;
    lines.push(`${changes[i].type} ${changes[i].line}`);
  }

  return { diff: lines.join('\n'), linesAdded, linesRemoved };
}
