import type { ReactNode } from 'react';
import { Text } from 'ink';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { formatToolModel } from '../../../../core/model-display.js';
import type { Theme } from '../../../../components/theme.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { Card } from './card.js';

type TaskCardEvent = Extract<EngineEvent, {
  type:
    | 'task_started'
    | 'task_completed'
    | 'task_skipped'
    | 'task_retry'
    | 'task_escalating'
    | 'task_full_fail'
    | 'task_tokens'
    | 'task_review_needed'
    | 'hint_failed';
}>;

function formatTaskStartedValue(event: EngineEventOf<'task_started'>): string {
  const parts = [`${event.file} (${event.action})`];
  const toolLabel = formatToolModel(event.tool, event.model);
  if (toolLabel) parts.push(toolLabel);
  if (event.implementerProfile) parts.push(`profile ${event.implementerProfile}`);
  if (event.contextFit) {
    const tokenLabel = event.contextLength === undefined
      ? `${event.estimatedTokens ?? '?'} tok`
      : `${event.estimatedTokens ?? '?'}/${event.contextLength} tok`;
    parts.push(`fit ${event.contextFit} ${tokenLabel}`);
  }
  if (event.currentCodeContextMode && event.currentCodeContextMode !== 'none') {
    parts.push(`code ${event.currentCodeContextMode}`);
  }
  if (event.costPosture) parts.push(`cost ${event.costPosture}`);

  return parts.join(' · ');
}

export function renderTaskCard(event: TaskCardEvent, t: Theme): ReactNode {
  switch (event.type) {
    case 'task_started':
      return (
        <Card
          label={
            <Text bold>
              T{event.index + 1}: {event.title}
            </Text>
          }
          labelColor={t.text}
          value={formatTaskStartedValue(event)}
          valueColor={t.textDim}
        />
      );
    case 'task_completed':
      return null;
    case 'task_skipped':
      return (
        <Card
          label="skipped"
          labelColor={t.textDim}
          value={`T${event.taskId} ${event.title}: ${event.reason}`}
          valueColor={t.textDim}
        />
      );
    case 'task_retry':
      return (
        <Card
          label="retry"
          labelColor={t.warning}
          value={`attempt ${event.attempt}/${event.maxRetries}`}
          valueColor={t.textDim}
        />
      );
    case 'task_escalating':
    case 'task_full_fail':
    case 'task_tokens':
    case 'task_review_needed':
    case 'hint_failed':
      return null;
    default:
      return assertNever(event);
  }
}
