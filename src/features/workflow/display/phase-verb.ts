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
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { stateTone } from '../../../core/theme/state-tone.js';
const REVIEW_PREFIX_PARTS: readonly ConversationRowSegment[] = [
  { text: 'Review', tone: CREW_SEAT_ROLES.review },
  { text: SOFT_SEP, tone: 'textDim' },
];
interface ReviewActivityParts {
  prefix: readonly ConversationRowSegment[];
  identity: ConversationRowSegment | null;
  suffix: readonly ConversationRowSegment[];
}

const REVIEW_WAITING_ACTIVITY: ReviewActivityParts = {
  prefix: REVIEW_PREFIX_PARTS,
  identity: null,
  suffix: [{ text: 'reviewing changes', tone: 'textDim' }],
};

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
      return reviewActivitySpans(
        reviewerLabel === null
          ? REVIEW_WAITING_ACTIVITY
          : {
              prefix: REVIEW_PREFIX_PARTS,
              identity: { text: reviewerLabel, tone: CREW_SEAT_ROLES.review },
              suffix: [],
            },
      )
        .map((part) => part.text)
        .join('');
    case 'idle':
    case 'complete':
      return '';
    default:
      return assertNever(phase);
  }
}

export function reviewActivityParts(
  operation: ActiveOperation | null | undefined,
  reviewerLabel: string | null,
): ReviewActivityParts {
  if (operation?.status !== 'running') return REVIEW_WAITING_ACTIVITY;
  switch (operation.role) {
    case 'review': {
      const step =
        operation.reviewStep === 'choosing-checks'
          ? 'choosing checks'
          : operation.reviewStep === 'verdict'
            ? 'reviewing changes'
            : operation.reviewStep === 'verify'
              ? 'verifying findings'
              : null;
      const waiting = isStatusFallback(operation) || step !== null;
      const identity =
        reviewerLabel === null ? null : { text: reviewerLabel, tone: CREW_SEAT_ROLES.review };
      return {
        prefix: REVIEW_PREFIX_PARTS,
        identity,
        suffix: waiting
          ? [
              ...(identity === null ? [] : [{ text: SOFT_SEP, tone: 'textDim' as const }]),
              { text: step ?? 'reviewing changes', tone: 'textDim' },
            ]
          : identity === null
            ? [{ text: 'reviewing', tone: 'textDim' }]
            : [],
      };
    }
    case 'summary':
    case 'compaction':
    case 'escalation':
      return {
        prefix: REVIEW_PREFIX_PARTS,
        identity: null,
        suffix: [{ text: runnerActivityRoleLabel(operation.role), tone: 'textDim' }],
      };
    // Only the review seat's own call runs in the final review (`isReviewSeatCall`); a planner
    // operation there is the stage's planner_status marker, not a call.
    case 'planner':
    case 'implementer':
      return REVIEW_WAITING_ACTIVITY;
    default:
      return assertNever(operation.role);
  }
}

export function reviewActivitySpans(parts: ReviewActivityParts): ConversationRowSegment[] {
  return [...parts.prefix, ...(parts.identity === null ? [] : [parts.identity]), ...parts.suffix];
}

export function suiteStatusParts(
  phase: Phase,
  suite: Pick<RunningSuiteStage, 'id' | 'moment' | 'command' | 'scenario'>,
  operation: ActiveOperation | null = null,
): ConversationRowSegment[] {
  const reviewing =
    phaseStage(phase) === 'review' ||
    (operation?.status === 'running' &&
      operation.role === 'review' &&
      operation.taskId === undefined);
  return [...(reviewing ? REVIEW_PREFIX_PARTS : []), ...suiteStageParts(suite, 'live')];
}

export function suiteStageParts(
  suite: Pick<RunningSuiteStage, 'id' | 'moment' | 'command' | 'scenario'>,
  context: 'live' | 'transcript',
): ConversationRowSegment[] {
  const leadTone = context === 'live' ? stateTone('running') : 'textDim';
  if (suite.scenario !== undefined) return [{ text: `Render ${suite.scenario}`, tone: leadTone }];
  // A check that did not run has no command to name.
  if (suite.command === '') return suiteMomentParts(suite, leadTone);
  return [
    ...suiteMomentParts(suite, leadTone),
    { text: SOFT_SEP, tone: 'textDim' },
    { text: suite.command, tone: 'textDim' },
  ];
}

function suiteMomentParts(
  suite: Pick<RunningSuiteStage, 'id' | 'moment'>,
  leadTone: ConversationRowSegment['tone'],
): ConversationRowSegment[] {
  const id = suite.id === undefined ? '' : ` ${suite.id}`;
  switch (suite.moment) {
    case 'plan':
      return [
        { text: 'Plan', tone: CREW_SEAT_ROLES.plan },
        { text: ` check${id}`, tone: 'textDim' },
      ];
    case 'base':
      return [{ text: `Base re-run${id}`, tone: leadTone }];
    case 'brief':
      return [{ text: `Fix check${id}`, tone: leadTone }];
    case 'verify':
      return [{ text: `Verify${id}`, tone: leadTone }];
    case 'pre-review':
      return suite.id === undefined
        ? [{ text: 'Pre-review suite', tone: 'textDim' }]
        : [
            { text: 'Reviewer', tone: CREW_SEAT_ROLES.review },
            { text: ` check${id}`, tone: 'textDim' },
          ];
    default:
      return assertNever(suite.moment);
  }
}
