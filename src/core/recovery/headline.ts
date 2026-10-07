import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { recoveryFactNumber, recoveryFactString } from '../schemas/recovery/facts.js';
import { SOFT_SEP } from '../separators.js';
import { formatResetAt } from './reset-clock.js';
import { haltOf, recoveryHaltLabel } from './halt.js';
import { assertNever } from '../../utils/type-guards.js';
import { countNoun } from '../../utils/pluralize.js';

function toolName(issue: RecoveryIssue): string {
  return recoveryFactString(issue.facts, 'tool') ?? 'the tool';
}

function taskName(issue: RecoveryIssue): string {
  return issue.taskId ?? 'the current brief';
}

function sentenceCase(reason: string): string {
  const words = reason.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A final review that judged the run and found blockers, in the one wording every surface shares. */
export function finalReviewFailedCause(blocking: number): string {
  return `Final review failed with ${countNoun(blocking, 'blocking finding')}`;
}

/** A final review the fix-cycle cap stopped: the run has spent every cycle it may. */
export function finalReviewCapCause(cycles: number): string {
  return `Final review failed after ${countNoun(cycles, 'fix cycle')}`;
}

/** A final review that failed on claims no check could verify, with nothing for the planner to fix. */
export function finalReviewUnverifiedCause(criteria: number): string {
  return `Final review failed with ${countNoun(criteria, 'unverified criterion', 'unverified criteria')}`;
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

/**
 * The halt in the words the operator needs: what stopped, on which tool or
 * brief, and — for a quota halt — when it comes back. Never the raw enums.
 */
export function formatRecoveryHeadline(issue: RecoveryIssue, now: number = Date.now()): string {
  switch (issue.reason) {
    case 'apply-conflict':
      return `Apply found ${countNoun(issue.files.length, 'conflicting file')}`;
    case 'apply-partial':
      return 'Apply stopped part way';
    case 'runner-usage-limit': {
      const reset = formatResetAt(issue.resetAt, now);
      return `Usage limit on ${toolName(issue)}${reset === undefined ? '' : ` · ${reset}`}`;
    }
    case 'runner-unauthenticated':
      return `Signed out of ${toolName(issue)}`;
    case 'retry-exhausted':
      return retryExhaustedCause({
        task: taskName(issue),
        plannerVerdict: recoveryFactString(issue.facts, 'plannerVerdict'),
        hookReason: recoveryFactString(issue.facts, 'escalationBlockedBy'),
      });
    case 'consult-bound-spent':
      return `${taskName(issue)} used its consult allowance`;
    case 'planner-calls-spent':
      return 'The run used its planner-call allowance';
    case 'scope-violation':
      return `${taskName(issue)} wrote outside its declared files`;
    case 'implementer-recipe-invalid':
      return `Tool recipe rejected by ${toolName(issue)}`;
    case 'implementer-left-isolation':
      return `${taskName(issue)} left the isolation directory`;
    case 'checkout-changed': {
      const changes = recoveryFactString(issue.facts, 'changes');
      const lead = `Repository changed under ${taskName(issue)}`;
      return changes === undefined ? lead : `${lead}${SOFT_SEP}${changes}`;
    }
    case 'runner-timeout-repeated':
      return `Two timeouts in a row on ${taskName(issue)}`;
    case 'planner-call-failed':
      return 'Planner call failed';
    case 'seat-protocol-error':
      return 'Seat answer did not match its contract';
    case 'planner-returned-no-briefs':
      return 'Planner returned no briefs';
    case 'constitution-check-failed':
      return 'Constitution check failed';
    case 'brief-review-no-progress':
      return 'Brief review is not making progress';
    case 'brief-quality-unrepaired':
      return 'Task Briefs still fail the quality gate';
    case 'plan-questions-exhausted':
      return 'Planner still asks questions after 2 rounds';
    case 'plan-checks-failed':
      return 'Plan still fails its checks after one repair';
    case 'review-input-too-large':
      return `Review input too large for ${toolName(issue)}`;
    case 'required-checks-unrunnable': {
      const ids = recoveryFactString(issue.facts, 'requiredCheckIds');
      return ids === undefined
        ? 'Required checks cannot run'
        : `Required checks cannot run: ${ids}`;
    }
    case 'review-failed': {
      // A final review halt names no brief: it judged the whole run, or it judged nothing.
      const cycles = recoveryFactNumber(issue.facts, 'fixCycles');
      if (cycles !== undefined) return finalReviewCapCause(cycles);
      const unverified = recoveryFactNumber(issue.facts, 'unverified');
      if (unverified !== undefined) return finalReviewUnverifiedCause(unverified);
      const blocking = recoveryFactNumber(issue.facts, 'blocking');
      if (blocking !== undefined) return finalReviewFailedCause(blocking);
      return recoveryFactString(issue.facts, 'reviewFailureKind') === undefined
        ? 'Final review failed'
        : 'Final review reached no verdict';
    }
    case 'implementation-error':
    case 'validation-failed':
    case 'context-overflow':
    case 'user-edit-conflict':
    case 'approval-promotion-conflict':
    case 'dependency-blocked':
    case 'approval-denied':
    case 'snapshot-failed':
      return `${sentenceCase(issue.reason)} on ${taskName(issue)}`;
    default:
      return assertNever(issue.reason);
  }
}

/** The halt and its cause on one line: "Needs you · …" or "Seat down · …". */
export function formatRecoveryTitle(cause: string, issue: Pick<RecoveryIssue, 'reason'>): string {
  return `${recoveryHaltLabel(haltOf(issue.reason))} · ${cause}`;
}
