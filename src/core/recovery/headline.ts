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
      return `${taskName(issue)} exhausted its retries`;
    case 'scope-violation':
      return `${taskName(issue)} wrote outside its declared files`;
    case 'implementer-recipe-invalid':
      return `Tool recipe rejected by ${toolName(issue)}`;
    case 'implementer-timeout-repeated':
      return `Two timeouts in a row on ${taskName(issue)}`;
    case 'implementation-error':
    case 'validation-failed':
    case 'context-overflow':
    case 'user-edit-conflict':
    case 'approval-promotion-conflict':
    case 'budget-paused':
    case 'budget-exceeded':
    case 'dependency-blocked':
    case 'review-failed':
    case 'approval-denied':
    case 'snapshot-failed':
      return `${sentenceCase(issue.reason)} on ${taskName(issue)}`;
    default:
      return assertNever(issue.reason);
  }
}
