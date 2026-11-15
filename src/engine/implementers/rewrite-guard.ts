const MIN_GUARDED_BASELINE_LINES = 5;
const MAX_WHOLE_FILE_SHRINK = 0.5;

function countNonEmptyLines(content: string): number {
  return content.split('\n').filter((line) => line.trim().length > 0).length;
}

export function shrinkRefusal(
  baseline: string,
  candidate: string,
): { kept: number; had: number } | undefined {
  const had = countNonEmptyLines(baseline);
  const kept = countNonEmptyLines(candidate);
  if (had < MIN_GUARDED_BASELINE_LINES || kept >= had * MAX_WHOLE_FILE_SHRINK) return undefined;
  return { kept, had };
}
