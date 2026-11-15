import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type {
  RunnerActivityLedgerLabel,
  RunnerActivitySeverity,
} from '../../display/runner-activity/types.js';
import type { ConversationRowTone } from '../types.js';

export function toneToConversationTone(
  tone: 'info' | 'success' | 'warning' | 'error' | 'textDim',
): ConversationRowTone {
  switch (tone) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'textDim':
      return 'textDim';
    default:
      return assertNever(tone);
  }
}

export function activityLabelTone(
  label: RunnerActivityLedgerLabel,
  severity: RunnerActivitySeverity,
): ConversationRowTone {
  if (label === 'PLAN') return CREW_SEAT_ROLES.plan;
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  switch (label) {
    case 'RUN':
    case 'CALL':
    case 'EDIT':
      return 'accent';
    case 'READ':
    case 'FIND':
    case 'LIST':
    case 'AGENT':
      return 'textDim';
    case 'WARN':
    case 'STOP':
      return 'warning';
    case 'ERR':
      return 'error';
    default:
      return assertNever(label);
  }
}
