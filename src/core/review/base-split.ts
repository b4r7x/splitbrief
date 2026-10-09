/**
 * How the failures of a red command split at the run base, in the words every surface uses: the
 * verdict, and why when every failure is pre-existing or some are not verified at the run base.
 * `notVerified` counts the failures that are red at the run base too without proof that they are the
 * same failure; `reason` says why. They are neither new nor pre-existing: the reviewer decides. The
 * new and pre-existing counts are left out when both are zero.
 */
export function baseSplit(counts: {
  newFailures: number;
  preExisting: number;
  notVerified?: number | undefined;
  reason?: string | undefined;
}): {
  verdict: string;
  why: string | null;
} {
  const notVerified = counts.notVerified ?? 0;
  if (counts.newFailures > 0 || notVerified > 0) {
    const parts =
      counts.newFailures + counts.preExisting > 0
        ? [`${counts.newFailures}\u00a0new`, `${counts.preExisting}\u00a0pre-existing`]
        : [];
    if (notVerified > 0) parts.push(`${notVerified}\u00a0not verified at the run base`);
    return { verdict: parts.join(', '), why: notVerified > 0 ? (counts.reason ?? null) : null };
  }
  const failures =
    counts.preExisting === 1
      ? 'the failure also fails'
      : `all ${counts.preExisting} failures also fail`;
  return { verdict: 'pre-existing', why: `${failures} before this run's changes` };
}
