import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { recoveryActionParts } from '../../../../core/recovery/action-label.js';
import { stripRecoveryResetClause } from '../../../../core/recovery/reset-clock.js';
import { arrowSep, SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { COLLAPSE_HINT } from '../blocks/implementer-diff-card.js';
import { compositeBlock, wholeSegmentsBlock } from '../blocks/compose.js';
import { wrappedTextBlock } from '../blocks/wrapped-text.js';
import type { RecoveryFold } from '../transcript-walk/types.js';
import type {
  ConversationRowBlock,
  ConversationRowSegment,
  ConversationRowTone,
} from '../types.js';

export function recoveryRowBlock(
  keyPrefix: string,
  recovery: RecoveryFold,
  width: number,
  expanded = false,
): ConversationRowBlock | null {
  if (recovery.automaticSwitch !== undefined) {
    const { diagnostics } = recovery;
    return compositeBlock(keyPrefix, [
      recoveryCardBlock(
        keyPrefix,
        [
          recoveryHeadlineSegments(recovery.prompted),
          [
            { text: `${arrowSep()}continued on fallback`, tone: 'textDim' },
            ...(diagnostics.length === 0
              ? []
              : [
                  {
                    text: expanded ? '' : '  ctrl+d',
                    tone: 'textDim',
                  } satisfies ConversationRowSegment,
                ]),
          ],
        ],
        width,
        stateTone('passed'),
      ),
      expanded
        ? wrappedTextBlock({
            keyPrefix: `${keyPrefix}-details`,
            text: [...diagnostics, COLLAPSE_HINT].join('\n'),
            width,
            tone: 'textDim',
            kind: 'card',
            indent: 2,
          })
        : null,
    ]);
  }
  const { prompted, reset, resolved } = recovery;
  const chosen = recovery.selected ?? resolved;
  const outcome = [
    reset === undefined ? null : `${reset.taskId} back to pending`,
    resolved === undefined ? null : recoveryOutcomeWords(resolved.outcome, recovery),
  ].filter((part): part is string => part !== null);
  const done = chosen === undefined ? [] : recoveryActionSegments(chosen, recovery.seatSwitch);
  const result: ConversationRowSegment[] =
    done.length > 0 && outcome.length > 0
      ? [{ text: `${arrowSep()}${outcome.join(', ')}`, tone: 'textDim' }]
      : [];
  // The prompt panel carries the clock; the row names what happened, once.
  const halt =
    prompted === undefined || recovery.haltAlreadyShown ? [] : recoveryHeadlineSegments(prompted);
  return recoveryCardBlock(
    keyPrefix,
    [
      [
        ...halt,
        ...(halt.length > 0 && done.length > 0
          ? [{ text: SOFT_SEP, tone: 'textDim' as const }]
          : []),
        ...done,
      ],
      result,
    ],
    width,
    resolved === undefined ? stateTone('attention') : recoveryResolvedTone(resolved.outcome),
  );
}

export function recoveryActionFailedRowBlock(
  keyPrefix: string,
  event: EngineEventOf<'recovery_action_failed'>,
  width: number,
): ConversationRowBlock | null {
  return recoveryCardBlock(
    keyPrefix,
    [
      [
        ...recoveryActionSegments(event),
        { text: ' ', tone: 'textDim' },
        { text: 'blocked', tone: stateTone('failed') },
        { text: ': ', tone: 'textDim' },
        { text: event.message, tone: 'textDim' },
      ],
    ],
    width,
    stateTone('failed'),
  );
}

// Each chunk moves to the next row whole, so `→ skipped` never splits from its arrow.
function recoveryCardBlock(
  keyPrefix: string,
  [first, ...rest]: readonly [
    readonly ConversationRowSegment[],
    ...(readonly ConversationRowSegment[])[],
  ],
  width: number,
  tone: ConversationRowTone,
): ConversationRowBlock | null {
  const empty = first.length === 0 && rest.every((chunk) => chunk.length === 0);
  return wholeSegmentsBlock(
    keyPrefix,
    [[{ text: empty ? 'Recovery' : 'Recovery  ', tone }, ...first], ...rest],
    width,
    'card',
  );
}

function recoveryActionSegments(
  event: Pick<
    EngineEventOf<'recovery_action_selected'>,
    'action' | 'reason' | 'seat' | 'reviewNone'
  >,
  switched?: EngineEventOf<'seat_switched'>,
): ConversationRowSegment[] {
  const modelChanged =
    event.action === 'switch-seat' &&
    switched !== undefined &&
    typeof switched.from !== 'string' &&
    typeof switched.to !== 'string' &&
    switched.from.tool === switched.to.tool &&
    switched.from.model !== switched.to.model;
  return recoveryActionParts(event.action, {
    reason: event.reason,
    seat: event.seat,
    reviewNone: event.reviewNone,
  }).map((part) => ({
    text: modelChanged ? part.text.replace('tool', 'model') : part.text,
    tone: part.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[part.seat],
  }));
}

function recoveryHeadlineSegments(
  event: EngineEventOf<'recovery_prompted'>,
): ConversationRowSegment[] {
  return (event.headlineSpans ?? [{ text: event.headline }]).map((part) => ({
    text: stripRecoveryResetClause(part.text),
    tone: part.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[part.seat],
  }));
}

function recoveryOutcomeWords(
  outcome: EngineEventOf<'recovery_resolved'>['outcome'],
  recovery: RecoveryFold,
): string {
  if (
    recovery.seatSwitch !== undefined &&
    recovery.resolved?.action === 'switch-seat' &&
    (outcome === 'continued' || outcome === 'retry-current-task')
  ) {
    const taskId = recovery.prompted?.taskId ?? recovery.reset?.taskId;
    return taskId === undefined ? 'continued on new seat' : `${taskId} resumed on new seat`;
  }
  switch (outcome) {
    case 'continued':
      return 'continued';
    case 'retry-current-task':
      return 'retried';
    case 'skipped-current-task':
      return 'skipped';
    case 'aborted':
      return 'run ended';
    default:
      return assertNever(outcome);
  }
}

function recoveryResolvedTone(
  outcome: EngineEventOf<'recovery_resolved'>['outcome'],
): ConversationRowTone {
  switch (outcome) {
    case 'continued':
    case 'retry-current-task':
      return stateTone('passed');
    case 'skipped-current-task':
    case 'aborted':
      return stateTone('attention');
    default:
      return assertNever(outcome);
  }
}
