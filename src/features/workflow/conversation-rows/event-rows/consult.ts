import { CREW_SEAT_LABELS } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { stuckAnswerWords } from '../../../../core/review/stuck.js';
import { SOFT_SEP, arrowSep } from '../../../../core/separators.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type { ConversationRowSegment } from '../types.js';

export function consultAnsweredSegments(
  event: EngineEventOf<'consult_answered'>,
): ConversationRowSegment[] {
  const seat =
    event.reason === 'deviation' && (event.action === 'confirm' || event.action === 'ask-user')
      ? 'plan'
      : (event.seat ?? 'plan');
  const label = { text: CREW_SEAT_LABELS[seat], tone: CREW_SEAT_ROLES[seat] };
  if (event.reason === 'deviation') {
    if (event.action === 'confirm') {
      const confirmed = event.decisionCount ?? 0;
      const rejected = event.rejectedCount ?? 0;
      const decided =
        rejected === 0
          ? `confirmed ${countNoun(confirmed, 'decision')}`
          : confirmed === 0
            ? `rejected ${countNoun(rejected, 'decision')}`
            : `confirmed ${countNoun(confirmed, 'decision')}, rejected ${rejected}`;
      return [
        label,
        { text: ` ${decided} for ${event.taskId}`, tone: 'textDim' },
        { text: SOFT_SEP, tone: 'textDim' },
        { text: event.diagnosis, tone: 'textDim' },
      ];
    }
    if (event.action === 'ask-user') {
      return [
        label,
        { text: ` asks you about the decisions ${event.taskId} reported`, tone: 'textDim' },
      ];
    }
  }
  if (event.reason === 'no-progress') {
    return [
      label,
      { text: `${arrowSep()}review stuck after ${event.taskId}${SOFT_SEP}`, tone: 'textDim' },
      { text: stuckAnswerWords(event), tone: 'textDim' },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: event.diagnosis, tone: 'textDim' },
    ];
  }
  return [
    label,
    { text: `${arrowSep()}${event.taskId}: `, tone: 'textDim' },
    ...consultAnsweredAction(event),
  ];
}

function consultAnsweredAction(event: EngineEventOf<'consult_answered'>): ConversationRowSegment[] {
  const detail = (text: string): ConversationRowSegment[] => [
    { text, tone: 'textDim' },
    { text: SOFT_SEP, tone: 'textDim' },
    { text: event.diagnosis, tone: 'textDim' },
  ];
  switch (event.action) {
    case 'guidance':
      return detail('guidance');
    case 'rewrite-task':
      return [
        {
          text:
            event.revision === undefined
              ? `rewrote ${event.taskId}`
              : `rewrote ${event.taskId} (rev ${event.revision})`,
          tone: 'textDim',
        },
      ];
    case 'split-task': {
      const ids = event.newTaskIds;
      const summary = ids === null || ids.length === 0 ? 'split' : `split into ${ids.join(', ')}`;
      return detail(summary);
    }
    case 'verify':
      return [
        {
          text:
            event.checkIds === undefined || event.checkIds.length === 0
              ? 'verify'
              : `verify ${event.checkIds.join(', ')}`,
          tone: 'textDim',
        },
      ];
    case 'ask-user':
      return [{ text: 'asks you', tone: 'textDim' }];
    case 'cannot':
      return detail('cannot be done');
    case 'accept':
      return detail('accepts the blockers');
    case 'confirm':
      return detail('confirmed the deviation');
    default:
      return assertNever(event.action);
  }
}
