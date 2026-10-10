import type { ReviewVerdict } from '../schemas/review.js';
import { reviewOutcomeWord, type ReviewOutcome } from './verdict.js';

export function renderReviewMarkdown(verdict: ReviewVerdict, outcome: ReviewOutcome): string {
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
  if (outcome.blocking.length === 0) {
    lines.push('None.');
  } else {
    for (const finding of outcome.blocking) lines.push(`- ${finding.text}`);
  }
  lines.push('', '**Note**', '');
  if (outcome.minor.length === 0 && outcome.outOfScope.length === 0) {
    lines.push('None.');
  } else {
    for (const finding of outcome.minor) lines.push(`- ${finding.text}`);
    for (const finding of outcome.outOfScope)
      lines.push(`- Outside the task review scope: ${finding.text}`);
  }
  lines.push('');
  return lines.join('\n');
}
