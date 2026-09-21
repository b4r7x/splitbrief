import type { Task } from '../../core/schemas/task.js';
import { taskFiles } from '../../core/schemas/task.js';
import type { ParsedFinalReview } from '../parsers/final-review.js';

export type ReviewPhaseStatus = 'written' | 'failed' | 'unparseable';

export type ReviewOutcome =
  | { kind: 'pass' }
  | { kind: 'fail'; blocking: number }
  | { kind: 'fix'; fixes: Record<string, string[]> };

export type ReviewOutcomeInput = {
  verdict: ParsedFinalReview | null;
  reviewStatus: ReviewPhaseStatus;
};

/**
 * A Critical finding belongs to the brief whose declared files it names. The
 * reviewer writes prose, not task ids, so ownership is a path substring in
 * brief order; a finding that names no brief is the last brief's to answer
 * (`VERDICT_RULES.unmatchedFindingOwner`) rather than nobody's.
 */
function assignFindings(findings: readonly string[], tasks: Task[]): Record<string, string[]> {
  const last = tasks[tasks.length - 1];
  if (last === undefined) return {};
  const fixes: Record<string, string[]> = {};
  for (const text of findings) {
    const owner = tasks.find((task) => taskFiles(task).some((file) => text.includes(file))) ?? last;
    fixes[owner.id] = [...(fixes[owner.id] ?? []), text];
  }
  return fixes;
}

export function decideReviewOutcome(
  review: ReviewOutcomeInput,
  tasks: Task[],
  cap: number,
  cycle: number,
): ReviewOutcome {
  const verdict = review.verdict?.verdict ?? null;
  const critical = (review.verdict?.findings ?? [])
    .filter((finding) => finding.severity === 'critical')
    .map((finding) => finding.text);

  if (
    review.reviewStatus === 'written' &&
    critical.length === 0 &&
    (verdict === 'pass' || verdict === 'pass_with_notes')
  ) {
    return { kind: 'pass' };
  }

  const fixes =
    review.reviewStatus === 'written' && cycle < cap ? assignFindings(critical, tasks) : {};
  if (Object.keys(fixes).length === 0) return { kind: 'fail', blocking: critical.length };
  return { kind: 'fix', fixes };
}
