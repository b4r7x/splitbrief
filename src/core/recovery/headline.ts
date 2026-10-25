import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { recoveryFactNumber, recoveryFactString } from '../schemas/recovery/facts.js';
import { SOFT_SEP } from '../separators.js';
import { formatResetAt } from './reset-clock.js';
import { assertNever } from '../../utils/type-guards.js';
import { countNoun } from '../../utils/pluralize.js';
import { formatAccountCause } from './account-cause.js';
import { formatNoCredential } from '../runners/route-auth.js';
import type { SeatLineSpan } from '../crew/identity.js';
import type { SeatSwitchCause } from '../schemas/workflow.js';

type RecoveryHeadlineInput = Pick<
  RecoveryIssue,
  'reason' | 'seat' | 'taskId' | 'files' | 'facts' | 'resetAt'
>;

function toolName(issue: RecoveryHeadlineInput): string {
  return recoveryFactString(issue.facts, 'tool') ?? 'the tool';
}

function taskName(issue: RecoveryHeadlineInput): string {
  return issue.taskId ?? 'the current brief';
}

function sentenceCase(reason: string): string {
  const words = reason.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The review a halt names, in the transcript's words: a task review by the brief it judged. */
export function reviewName(
  review: Readonly<{ scope?: string | undefined; afterTaskId?: string | undefined }>,
): string {
  if (review.scope !== 'task') return 'Final review';
  return review.afterTaskId === undefined ? 'Task review' : `Review ${review.afterTaskId}`;
}

/** What tells final reviews apart: the fix cycles before one, and a re-run within one cycle. */
export function finalReviewAnchor(fixCycles: number, reruns: number): string | undefined {
  const parts = [
    ...(fixCycles > 0 ? [`after ${countNoun(fixCycles, 'fix cycle')}`] : []),
    ...(reruns > 0 ? [reruns === 1 ? 're-run' : `re-run ${reruns}`] : []),
  ];
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** A review that judged its scope and found blockers, in the one wording every surface shares. */
export function reviewFailedCause(review: string, blocking: number): string {
  return `${review} failed with ${countNoun(blocking, 'blocking finding')}`;
}

/** A review the fix-cycle cap stopped: the run has spent every cycle it may. */
export function reviewCapCause(review: string, cycles: number): string {
  return `${review} failed after ${countNoun(cycles, 'fix cycle')}`;
}

/** A review that failed on claims no check could verify, with nothing for the planner to fix. */
export function reviewUnverifiedCause(review: string, criteria: number): string {
  return `${review} failed with ${countNoun(criteria, 'unverified criterion', 'unverified criteria')}`;
}

/** What stopped a retry-exhausted brief, in the one wording the transcript, the panel and the byline share. */
export function retryExhaustedCause(
  cause: Readonly<{
    task: string;
    plannerVerdict?: string | undefined;
    hookReason?: string | undefined;
  }>,
): string {
  if (cause.plannerVerdict === 'brief') return `${cause.task}: the planner found the brief wrong`;
  if (cause.hookReason !== undefined) {
    return `${cause.task} escalation blocked by pre_escalation hook: ${cause.hookReason}`;
  }
  return `${cause.task} failed`;
}

/** A repository change under a brief, with the changes the audit saw, in the words every surface shares. */
export function repositoryChangedCause(task: string, changes: string | undefined): string {
  const lead = `Repository changed under ${task}`;
  return changes === undefined ? lead : `${lead}${SOFT_SEP}${changes}`;
}

/** A brief whose tool call named a path outside the run's isolation directory. */
export function leftIsolationCause(task: string): string {
  return `${task} left the isolation directory`;
}

/** A model the tool refused, on any seat: the `refusal` fact a model-refusal halt carries. */
function modelRefusalCause(issue: RecoveryHeadlineInput): string | undefined {
  switch (recoveryFactString(issue.facts, 'refusal')) {
    case 'wrong-model':
      return `Model not listed by ${toolName(issue)}`;
    case 'unknown':
      return `Model refused by ${toolName(issue)}`;
    default:
      return undefined;
  }
}

/**
 * The halt in the words the operator needs: what stopped, on which tool or
 * brief, and — for a quota halt — when it comes back. Never the raw enums.
 */
export function formatRecoveryHeadlineSpans(
  issue: RecoveryHeadlineInput,
  now: number = Date.now(),
): readonly SeatLineSpan[] {
  switch (issue.reason) {
    case 'apply-conflict':
      return [{ text: `Apply found ${countNoun(issue.files.length, 'conflicting file')}` }];
    case 'apply-partial':
      return [{ text: 'Apply stopped part way' }];
    case 'runner-usage-limit': {
      const cause = recoveryFactString(issue.facts, 'cause');
      switch (cause) {
        case 'balance':
        case 'billing':
        case 'quota':
          return [{ text: formatAccountCause(cause, toolName(issue)) }];
      }
      const reset = formatResetAt(issue.resetAt, now);
      return [
        { text: `Usage limit on ${toolName(issue)}${reset === undefined ? '' : ` · ${reset}`}` },
      ];
    }
    case 'runner-unauthenticated': {
      const provider = recoveryFactString(issue.facts, 'provider');
      return [
        {
          text:
            provider === undefined
              ? formatAccountCause('auth', toolName(issue))
              : formatNoCredential(toolName(issue), provider),
        },
      ];
    }
    case 'retry-exhausted':
      return [
        {
          text: retryExhaustedCause({
            task: taskName(issue),
            plannerVerdict: recoveryFactString(issue.facts, 'plannerVerdict'),
            hookReason: recoveryFactString(issue.facts, 'escalationBlockedBy'),
          }),
        },
      ];
    case 'consult-bound-spent':
      return [{ text: `${taskName(issue)} used its consult allowance` }];
    case 'planner-calls-spent':
      return [{ text: 'The run used its planner-call allowance' }];
    case 'scope-violation':
      return [{ text: `${taskName(issue)} wrote outside its declared files` }];
    case 'implementer-recipe-invalid':
      return [{ text: modelRefusalCause(issue) ?? `Tool recipe rejected by ${toolName(issue)}` }];
    case 'implementer-left-isolation':
      return [{ text: leftIsolationCause(taskName(issue)) }];
    case 'checkout-changed':
      return [
        {
          text: repositoryChangedCause(taskName(issue), recoveryFactString(issue.facts, 'changes')),
        },
      ];
    case 'runner-timeout-repeated':
      return [{ text: `Two timeouts in a row on ${taskName(issue)}` }];
    case 'planner-call-failed': {
      const refusal = modelRefusalCause(issue);
      if (refusal !== undefined) return [{ text: refusal }];
      return [
        {
          text: issue.seat === 'review' ? 'Reviewer' : 'Planner',
          seat: issue.seat === 'review' ? 'review' : 'plan',
        },
        { text: ' call failed' },
      ];
    }
    case 'seat-protocol-error':
      return [{ text: 'Seat answer did not match its contract' }];
    case 'planner-returned-no-briefs':
      return [{ text: 'Planner', seat: 'plan' }, { text: ' returned no briefs' }];
    case 'constitution-check-failed':
      return [{ text: 'Constitution check failed' }];
    case 'brief-review-no-progress':
      return [{ text: 'Brief review is not making progress' }];
    case 'brief-quality-unrepaired':
      return [{ text: 'Task Briefs still fail the quality gate' }];
    case 'plan-questions-exhausted':
      return [{ text: 'Planner', seat: 'plan' }, { text: ' still asks questions after 2 rounds' }];
    case 'plan-checks-failed':
      return [{ text: 'Plan', seat: 'plan' }, { text: ' still fails its checks after one repair' }];
    case 'review-input-too-large':
      return [
        { text: 'Review', seat: 'review' },
        { text: ` input too large for ${toolName(issue)}` },
      ];
    case 'required-checks-unrunnable': {
      const ids = recoveryFactString(issue.facts, 'requiredCheckIds');
      return [
        {
          text:
            ids === undefined ? 'Required checks cannot run' : `Required checks cannot run: ${ids}`,
        },
      ];
    }
    case 'review-failed': {
      // A task review halt names the brief it judged; a final review halt names no brief.
      const review = reviewName({
        scope: recoveryFactString(issue.facts, 'reviewScope'),
        afterTaskId: recoveryFactString(issue.facts, 'afterTaskId'),
      });
      const cycles = recoveryFactNumber(issue.facts, 'fixCycles');
      if (cycles !== undefined) return [{ text: reviewCapCause(review, cycles) }];
      const unverified = recoveryFactNumber(issue.facts, 'unverified');
      if (unverified !== undefined) return [{ text: reviewUnverifiedCause(review, unverified) }];
      const blocking = recoveryFactNumber(issue.facts, 'blocking');
      if (blocking !== undefined) return [{ text: reviewFailedCause(review, blocking) }];
      return [
        {
          text:
            recoveryFactString(issue.facts, 'reviewFailureKind') === undefined
              ? `${review} failed`
              : `${review} reached no verdict`,
        },
      ];
    }
    // Only the halt for a prompt the tool refused as too large names its tool; a brief too large
    // for every profile names none.
    case 'context-overflow': {
      const tool = recoveryFactString(issue.facts, 'tool');
      return [
        {
          text:
            tool === undefined
              ? `Context overflow on ${taskName(issue)}`
              : `Prompt too large for ${tool} on ${taskName(issue)}`,
        },
      ];
    }
    case 'implementation-error':
    case 'validation-failed':
    case 'user-edit-conflict':
    case 'approval-promotion-conflict':
    case 'dependency-blocked':
    case 'approval-denied':
    case 'snapshot-failed':
      return [{ text: `${sentenceCase(issue.reason)} on ${taskName(issue)}` }];
    default:
      return assertNever(issue.reason);
  }
}

export function formatRecoveryHeadline(issue: RecoveryIssue, now: number = Date.now()): string {
  return formatRecoveryHeadlineSpans(issue, now)
    .map((span) => span.text)
    .join('');
}

export function formatSeatSwitchCause(record: {
  cause: SeatSwitchCause;
  headline?: string | undefined;
}): string {
  if (record.headline !== undefined) return record.headline;
  switch (record.cause) {
    case 'runner-usage-limit':
      return 'usage limit';
    case 'runner-unauthenticated':
      return 'signed out';
    default:
      return record.cause.replaceAll('-', ' ');
  }
}
