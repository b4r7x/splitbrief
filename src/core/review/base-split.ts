/**
 * How the failures of a red command split at the run base, in the words every surface uses: the
 * verdict, and why when every failure is pre-existing.
 */
export function baseSplit(counts: { newFailures: number; preExisting: number }): {
  verdict: string;
  why: string | null;
} {
  if (counts.newFailures > 0) {
    return { verdict: `${counts.newFailures} new, ${counts.preExisting} pre-existing`, why: null };
  }
  const failures =
    counts.preExisting === 1
      ? 'the failure also fails'
      : `all ${counts.preExisting} failures also fail`;
  return { verdict: 'pre-existing', why: `${failures} before this run's changes` };
}
