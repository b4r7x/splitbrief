import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { recoveryHaltLabel, haltOf } from '../../../core/recovery/halt.js';
import {
  formatRecoveryHeadline,
  formatRecoveryHeadlineSpans,
} from '../../../core/recovery/headline.js';
import { recoveryFactString } from '../../../core/schemas/recovery/facts.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { separatedSpans } from '../conversation-rows/row-format/text.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import {
  readRecoveryContext,
  recoveryContextSeatLabel,
  recoveryContextCauseWords,
} from '../usage/recovery-context.js';

export function formatRecoveryHeaderParts(issue: RecoveryIssue): ConversationRowSegment[] {
  return [
    { text: recoveryHaltLabel(haltOf(issue.reason)), tone: stateTone('attention') },
    { text: SOFT_SEP, tone: 'textDim' },
    ...recoveryCauseParts(issue),
  ];
}

function recoveryCauseParts(issue: RecoveryIssue): ConversationRowSegment[] {
  const context = readRecoveryContext(issue);
  if (context !== null)
    return [
      { text: 'Nothing was sent to ', tone: 'text' },
      { text: recoveryContextSeatLabel(context), tone: CREW_SEAT_ROLES[context.seat] },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: recoveryContextCauseWords(context), tone: 'text' },
    ];
  if (
    (issue.reason === 'runner-usage-limit' || issue.reason === 'runner-unauthenticated') &&
    recoveryFactString(issue.facts, 'tool') !== undefined
  ) {
    return separatedSpans(formatRecoveryHeadline(issue), 'text');
  }
  // The engine's sentence carries the evidence for the headless sinks; here the evidence is the
  // first fact row, so the header names the halt and nothing is said twice. A checkout halt's
  // rows do not repeat its changes, so its header names them.
  if (
    issue.reason === 'implementer-recipe-invalid' ||
    recoveryFactString(issue.facts, 'refusal') !== undefined ||
    issue.facts?.reviewSeatNoImages === true ||
    issue.reason === 'implementer-left-isolation' ||
    issue.reason === 'checkout-changed' ||
    issue.reason === 'apply-conflict' ||
    issue.reason === 'apply-partial' ||
    issue.reason === 'review-input-too-large' ||
    issue.reason === 'required-checks-unrunnable' ||
    issue.reason === 'plan-questions-exhausted' ||
    issue.reason === 'plan-checks-failed' ||
    issue.reason === 'runner-timeout-repeated' ||
    issue.reason === 'runner-check-failed'
  ) {
    return recoveryHeadlineParts(issue);
  }
  // A retry-exhausted halt reads the transcript's own sentence, so a halt saved
  // under older words names its cause the way the transcript and the byline do.
  const cause = issue.reason === 'retry-exhausted' ? formatRecoveryHeadline(issue) : issue.message;
  return separatedSpans(cause, 'text');
}

export function recoveryHeadlineParts(issue: RecoveryIssue): ConversationRowSegment[] {
  return formatRecoveryHeadlineSpans(issue).flatMap((part) =>
    part.seat === undefined
      ? separatedSpans(part.text, 'text')
      : [{ text: part.text, tone: CREW_SEAT_ROLES[part.seat] }],
  );
}
