import type { ReactNode } from 'react';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import type { Theme } from '../../../../components/theme.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { Card } from './card.js';

type RecoveryCardEvent = Extract<EngineEvent, {
  type:
    | 'paused_external_changes'
    | 'recovery_prompted'
    | 'recovery_action_selected'
    | 'recovery_action_failed'
    | 'recovery_resolved'
    | 'rewind_to_spec'
    | 'rewind_to_plan'
    | 'task_reset';
}>;

function formatExternalChangesValue(event: EngineEventOf<'paused_external_changes'>): string {
  if (!event.conflict) {
    return event.selectedAction
      ? `External changes detected · ${event.selectedAction}`
      : 'External changes detected';
  }

  const files = event.conflict.files.slice(0, 3).join(', ');
  const hiddenCount = event.conflict.files.length - 3;
  const filesLabel = hiddenCount > 0
    ? `${files}, +${hiddenCount} more`
    : files || 'no files';
  const tasksLabel = event.conflict.affectedTaskIds.length > 0
    ? ` · tasks ${event.conflict.affectedTaskIds.join(', ')}`
    : '';
  const actionLabel = event.selectedAction ? ` · ${event.selectedAction}` : '';

  return `${event.conflict.kind} · ${filesLabel}${tasksLabel}${actionLabel}`;
}

export function renderRecoveryCard(event: RecoveryCardEvent, t: Theme): ReactNode {
  switch (event.type) {
    case 'paused_external_changes':
      return (
        <Card
          label="user edits"
          labelColor={event.conflict?.safeToContinue ? t.warning : t.error}
          value={formatExternalChangesValue(event)}
          valueColor={event.conflict?.safeToContinue ? t.textDim : t.error}
        />
      );
    case 'recovery_prompted':
      return (
        <Card
          label="recovery"
          labelColor={t.warning}
          value={`${event.reason}${event.taskId ? ` · ${event.taskId}` : ''} · recommended ${event.recommendedAction}`}
          valueColor={t.warning}
        />
      );
    case 'recovery_action_selected':
      return (
        <Card
          label="recovery"
          labelColor={t.info}
          value={`selected ${event.action} for ${event.reason}`}
          valueColor={t.textDim}
        />
      );
    case 'recovery_action_failed':
      return (
        <Card
          label="recovery"
          labelColor={t.error}
          value={`${event.action} blocked: ${event.message}`}
          valueColor={t.error}
        />
      );
    case 'recovery_resolved':
      return (
        <Card
          label="recovery"
          labelColor={t.success}
          value={`${event.outcome} via ${event.action}${event.implementerProfile ? ` · ${event.implementerProfile}` : ''}`}
          valueColor={t.textDim}
        />
      );
    case 'rewind_to_spec':
      return (
        <Card
          label="rewind → spec"
          labelColor={t.warning}
          value={event.comment || undefined}
          valueColor={t.textDim}
        />
      );
    case 'rewind_to_plan':
      return (
        <Card
          label="rewind → plan"
          labelColor={t.warning}
          value={event.comment || undefined}
          valueColor={t.textDim}
        />
      );
    case 'task_reset':
      return (
        <Card
          label="task reset"
          labelColor={t.warning}
          value={`Task ${event.taskId} set to pending`}
          valueColor={t.textDim}
        />
      );
    default:
      return assertNever(event);
  }
}
