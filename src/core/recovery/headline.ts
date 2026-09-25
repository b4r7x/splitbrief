import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { recoveryFactString } from '../schemas/recovery/facts.js';
import { formatResetNote } from './reset-clock.js';
import { assertNever } from '../../utils/type-guards.js';

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
  return `${cause.task} exhausted its retries`;
}

/**
 * The halt in the words the operator needs: what stopped, on which tool or
 * brief, and — for a quota halt — when it comes back. Never the raw enums.
 */
export function formatRecoveryHeadline(issue: RecoveryIssue, now: number = Date.now()): string {
  switch (issue.reason) {
    case 'runner-usage-limit': {
      const resetAt = issue.resetAt === undefined ? Number.NaN : Date.parse(issue.resetAt);
      const reset = Number.isFinite(resetAt) ? ` · ${formatResetNote(resetAt, now)}` : '';
      return `Usage limit on ${toolName(issue)}${reset}`;
    }
    case 'runner-unauthenticated':
      return `Signed out of ${toolName(issue)}`;
    case 'retry-exhausted':
      return retryExhaustedCause({
        task: taskName(issue),
        plannerVerdict: recoveryFactString(issue.facts, 'plannerVerdict'),
        hookReason: recoveryFactString(issue.facts, 'escalationBlockedBy'),
      });
    case 'scope-violation':
      return `${taskName(issue)} wrote outside its declared files`;
    case 'implementer-recipe-invalid':
      return `Tool recipe rejected by ${toolName(issue)}`;
    case 'implementer-left-isolation':
      return `${taskName(issue)} left the isolation directory`;
    case 'checkout-changed':
      return `Your checkout changed under ${taskName(issue)}`;
    case 'runner-timeout-repeated':
      return `Two timeouts in a row on ${taskName(issue)}`;
    case 'planner-call-failed':
      return 'Planner call failed';
    case 'planner-returned-no-briefs':
      return 'Planner returned no briefs';
    case 'constitution-check-failed':
      return 'Constitution check failed';
    case 'brief-review-no-progress':
      return 'Brief review is not making progress';
    case 'brief-quality-unrepaired':
      return 'Task Briefs still fail the quality gate';
    case 'implementation-error':
    case 'validation-failed':
    case 'context-overflow':
    case 'user-edit-conflict':
    case 'approval-promotion-conflict':
    case 'dependency-blocked':
    case 'review-failed':
    case 'approval-denied':
    case 'snapshot-failed':
      return `${sentenceCase(issue.reason)} on ${taskName(issue)}`;
    default:
      return assertNever(issue.reason);
  }
}
