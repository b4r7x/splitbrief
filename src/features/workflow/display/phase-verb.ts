import type { Phase } from '../../../core/schemas/enums.js';
import type { PlannerCall } from '../../../core/schemas/run-step.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type {
  ActiveOperation,
  RunningSuiteStage,
} from '../../../stores/workflow/operations/state.js';
import { phaseStage } from '../../../core/rail-stages.js';
import { assertNever } from '../../../utils/type-guards.js';
import { runnerActivityRoleLabel } from './runner-activity-display.js';
import { isStatusFallback } from '../../../stores/workflow/operations/planner-status.js';

export const REVIEW_WAITING_VERDICT = 'Review · waiting for the verdict';

// The plan stage is one planning session. Only an older run's briefs call has its own verb.
// A gate that rewrites its document after a change request uses that call's verb outside the gate.
export function activeVerb(
  phase: Phase,
  reviewerLabel: string | null,
  plannerCall: PlannerCall | null,
): string {
  switch (phase) {
    case 'researching':
      return 'Researching…';
    case 'specifying':
      return 'Specifying…';
    case 'reviewing-spec':
      if (plannerCall !== null) return activeVerb('specifying', reviewerLabel, plannerCall);
      return 'Reviewing spec…';
    case 'clarifying':
      return 'Clarifying…';
    case 'constitution-check':
      return 'Checking constitution…';
    case 'planning':
      if (plannerCall === 'tasks') return 'Compiling briefs…';
      return 'Planning…';
    case 'reviewing-plan':
      if (plannerCall !== null) return activeVerb('planning', reviewerLabel, plannerCall);
      return 'Reviewing plan…';
    case 'reviewing-briefs':
      if (plannerCall !== null) return activeVerb('planning', reviewerLabel, plannerCall);
      return 'Reviewing briefs…';
    case 'analyzing':
      return 'Analyzing…';
    case 'implementing':
      return 'Implementing…';
    case 'validating-task':
      return 'Validating…';
    case 'escalating':
      return 'Escalating…';
    case 'final-review':
      return reviewerLabel === null ? REVIEW_WAITING_VERDICT : `Review${SOFT_SEP}${reviewerLabel}`;
    case 'idle':
    case 'complete':
      return '';
    default:
      return assertNever(phase);
  }
}

export function reviewActivityText(
  operation: ActiveOperation | null | undefined,
  reviewerLabel: string | null,
): string {
  if (operation?.status !== 'running') return REVIEW_WAITING_VERDICT;
  switch (operation.role) {
    case 'review':
      if (isStatusFallback(operation)) {
        return reviewerLabel === null
          ? REVIEW_WAITING_VERDICT
          : `Review${SOFT_SEP}${reviewerLabel}${SOFT_SEP}waiting for the verdict`;
      }
      return reviewerLabel === null
        ? 'Review · reviewing'
        : activeVerb('final-review', reviewerLabel, null);
    case 'summary':
    case 'compaction':
    case 'escalation':
      return `Review${SOFT_SEP}${runnerActivityRoleLabel(operation.role)}`;
    case 'planner':
    case 'implementer':
      return REVIEW_WAITING_VERDICT;
    default:
      return assertNever(operation.role);
  }
}

export function suiteStatusText({
  phase,
  suite,
  operation = null,
}: {
  phase: Phase;
  suite: Pick<RunningSuiteStage, 'id' | 'moment' | 'command' | 'scenario'>;
  operation?: ActiveOperation | null;
}): string {
  const text = suiteStageText(suite);
  const reviewing =
    phaseStage(phase) === 'review' ||
    (operation?.status === 'running' &&
      operation.role === 'review' &&
      operation.taskId === undefined);
  return reviewing ? `Review${SOFT_SEP}${text}` : text;
}

/**
 * A check's id and command, or a render's scenario without command text. A full-suite stage from
 * an older session keeps the words it had.
 */
export function suiteStageText(
  suite: Pick<RunningSuiteStage, 'id' | 'moment' | 'command' | 'scenario'>,
): string {
  if (suite.scenario !== undefined) return `Render ${suite.scenario}`;
  return `${suiteMomentLabel(suite)}${SOFT_SEP}${suite.command}`;
}

function suiteMomentLabel(suite: Pick<RunningSuiteStage, 'id' | 'moment'>): string {
  const id = suite.id === undefined ? '' : ` ${suite.id}`;
  switch (suite.moment) {
    case 'plan':
      return `Plan check${id}`;
    case 'base':
      return `Base re-run${id}`;
    case 'brief':
      return `Fix check${id}`;
    case 'pre-review':
      return suite.id === undefined ? 'Pre-review suite' : `Reviewer check${id}`;
    default:
      return assertNever(suite.moment);
  }
}
