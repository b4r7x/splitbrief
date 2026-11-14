import type { ReviewVerdict, SetAside } from '../schemas/review/verdict.js';
import type { RedCheck, ReviewRecord } from '../schemas/workflow/review-record.js';
import { oneLineDisplayText } from '../../utils/display-text/sanitize.js';
import { namedFailures } from './base-split.js';
import { reviewOutcomeWord, setAsideLine, type ReviewOutcome } from './verdict.js';
import { acceptedCounts, acceptedNote, redCheckLine } from './accepted.js';

const PRE_EXISTING_LEAD =
  "These reviewer checks failed at the run base too. Their failures below also fail before this run's changes, so they raise no finding.";

const YOUR_ACCEPT = 'The planner did not accept this result. You accepted it as is';

/**
 * Who accepted a failed review as is: the planner with its note, or you with each red check that
 * still blocked and the note you gave.
 */
export type AcceptedReview =
  | Readonly<{ by: 'planner'; note: string }>
  | Readonly<{ by?: undefined; redChecks: readonly RedCheck[]; note?: string | undefined }>;

/**
 * `tasks` are the plan's tasks, whose titles name the task lines; `preExistingChecks` are the
 * reviewer checks that were red at the run base too; `setAside` are the red inputs the reviewer
 * rejected with a reason; `accepted` names who accepted the failed review as is.
 */
export function renderReviewMarkdown(
  verdict: ReviewVerdict,
  tasks: readonly { id: string; title: string }[],
  outcome: ReviewOutcome,
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>,
  setAside: readonly SetAside[],
  accepted?: AcceptedReview,
): string {
  const word = reviewOutcomeWord(outcome);
  const lines = ['### Verdict', '', word, '', '### Tasks', ''];
  if (verdict.tasks.length === 0) {
    lines.push('None.');
  } else {
    const titles = new Map(tasks.map((task) => [task.id, task.title]));
    for (const task of verdict.tasks) {
      const note = task.note.trim();
      const suffix = note === '' ? '' : ` — ${note}`;
      const title = titles.get(task.id);
      const name = title === undefined ? task.id : `${task.id} ${title}`;
      lines.push(`- [${task.plan}] ${name}${suffix}`);
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
    for (const input of outcome.redInputs) {
      const [first, ...rest] = input.text.split('\n');
      lines.push(`- ${input.id}: ${first}`, ...rest.map((line) => `  ${line}`));
    }
  }
  if (setAside.length > 0) {
    lines.push('', '**Set aside**', '');
    for (const entry of setAside) lines.push(`- ${setAsideLine(entry)}`);
  }
  if (accepted?.by === 'planner') {
    lines.push('', '**Accepted by the planner**', '', accepted.note.trim());
  } else if (accepted !== undefined) {
    const red = acceptedCounts(accepted).redChecks;
    lines.push(
      '',
      '**Accepted as is by you**',
      '',
      red === undefined ? `${YOUR_ACCEPT}.` : `${YOUR_ACCEPT}, with ${red}:`,
    );
    if (red !== undefined) {
      lines.push('');
      for (const check of accepted.redChecks) {
        lines.push(`- ${oneLineDisplayText(redCheckLine(check))}`);
      }
    }
    const note = acceptedNote(accepted);
    if (note !== undefined) lines.push('', note);
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
