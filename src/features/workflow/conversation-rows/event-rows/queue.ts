import { phaseStage } from '../../../../core/phases/rail.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { queueCopy } from '../../queue-copy.js';
import { cardRowsBlock, compositeBlock } from '../blocks/compose.js';
import { wrappedTextBlock } from '../blocks/wrapped-text.js';
import { INLINE_LABEL_GAP } from '../row-format/label-card.js';
import type { ConversationRowBlock } from '../types.js';

export function queueRowBlock(
  keyPrefix: string,
  event: EngineEventOf<
    'message_queued' | 'message_injected_native' | 'queue_drained' | 'queue_cleared'
  >,
  width: number,
): ConversationRowBlock | null {
  switch (event.type) {
    case 'message_queued':
    case 'message_injected_native': {
      const seat =
        event.type === 'message_injected_native' ? 'plan' : (event.seat ?? phaseStage(event.phase));
      const copy = queueCopy({
        seat,
        taskId: event.type === 'message_queued' ? event.taskId : undefined,
        steerable: event.type === 'message_queued' && event.steerable,
        checking: event.phase === 'validating-task',
        starting: event.type === 'message_queued' ? event.starting : undefined,
      });
      const header =
        event.type === 'message_injected_native'
          ? { ...copy.delivered, tone: 'success' as const }
          : event.origin === 'clarification'
            ? {
                label: 'Answered',
                value: 'recorded — applied at the next planner call',
                tone: 'success' as const,
              }
            : { ...copy.queued, tone: 'info' as const };
      return compositeBlock(keyPrefix, [
        cardRowsBlock({
          keyPrefix: `${keyPrefix}-header-0`,
          label: header.label,
          labelGap: header.label === 'Answered' ? undefined : INLINE_LABEL_GAP,
          value: header.value,
          width,
          labelTone: header.tone,
          valueTone: 'textDim',
          markerTone: header.tone,
        }),
        event.preview
          ? wrappedTextBlock({
              keyPrefix: `${keyPrefix}-preview-1`,
              text: event.preview,
              width,
              tone: 'text',
            })
          : null,
      ]);
    }
    case 'queue_drained': {
      const seat = event.seat ?? phaseStage(event.phase);
      const copy = queueCopy({ seat, taskId: event.taskId, count: event.count, via: event.via });
      return cardRowsBlock({
        keyPrefix,
        label: copy.delivered.label,
        labelGap: INLINE_LABEL_GAP,
        value: copy.delivered.value,
        width,
        labelTone: 'success',
        valueTone: 'textDim',
        markerTone: 'success',
      });
    }
    case 'queue_cleared': {
      const copy = queueCopy({ seat: null, count: event.count });
      return cardRowsBlock({
        keyPrefix,
        label: copy.cleared.label,
        value: copy.cleared.value,
        width,
        labelTone: 'textDim',
      });
    }
    default:
      return assertNever(event);
  }
}
