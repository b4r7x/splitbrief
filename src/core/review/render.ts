import type { ReviewVerdict } from '../schemas/review.js';
import type { ReviewRecord } from '../schemas/workflow.js';
import { namedFailures } from './base-split.js';
import { reviewOutcomeWord, setAsideLine, type ReviewOutcome, type SetAside } from './verdict.js';

const PRE_EXISTING_LEAD =
  "These reviewer checks failed at the run base too. Their failures below also fail before this run's changes, so they raise no finding.";

/**
 * `preExistingChecks` are the reviewer checks that were red at the run base too; `setAside` are the
 * red inputs the reviewer rejected with a reason.
 */
export function renderReviewMarkdown(
  verdict: ReviewVerdict,
  outcome: ReviewOutcome,
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>,
  setAside: readonly SetAside[],
): string {
  const word = reviewOutcomeWord(outcome);
  const lines = ['### Verdict', '', word, '', '### Tasks', ''];
  if (verdict.tasks.length === 0) {
    lines.push('None.');
  } else {
    for (const task of verdict.tasks) {
      const note = task.note.trim();
      const suffix = note === '' ? '' : ` — ${note}`;
      lines.push(`- [${task.plan}] ${task.id}${suffix}`);
    }
  }
  lines.push('', '### Criteria Results', '');
  if (verdict.criteria.length === 0) {
    lines.push('None.');
  } else {
    for (const criterion of outcome.criteria) {
      const evidence = criterion.evidence.trim();
      const suffix = evidence === '' ? '' : ` — ${evidence}`;
      lines.push(`- **[${criterion.status.toUpperCase()}]** ${criterion.id}${suffix}`);
    }
  }
  lines.push('', '### Findings', '', '**Critical**', '');
  if (outcome.blocking.length === 0 && outcome.redInputs.length === 0) {
    lines.push('None.');
  } else {
    for (const finding of outcome.blocking) lines.push(`- ${finding.text}`);
    for (const input of outcome.redInputs)
      lines.push(`- ${input.id}: ${input.text.split('\n', 1)[0]}`);
  }
  if (setAside.length > 0) {
    lines.push('', '**Set aside**', '');
    for (const entry of setAside) lines.push(`- ${setAsideLine(entry)}`);
  }
  lines.push('', '**Note**', '');
  if (outcome.minor.length === 0 && outcome.outOfScope.length === 0) {
    lines.push('None.');
  } else {
    for (const finding of outcome.minor) lines.push(`- ${finding.text}`);
    for (const finding of outcome.outOfScope)
      lines.push(`- Outside the task review scope: ${finding.text}`);
  }
  if (preExistingChecks.length > 0) {
    lines.push('', '### Pre-existing failures', '', PRE_EXISTING_LEAD, '');
    for (const check of preExistingChecks) {
      lines.push(`- ${check.id} \`${check.command}\``);
      for (const name of namedFailures(check.keys, check.keys.length)) lines.push(`  - ${name}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
