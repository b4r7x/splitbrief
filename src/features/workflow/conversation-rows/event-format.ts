import { formatToolModel } from '../../../core/model-display.js';
import { ValidationStageSchema, type ValidationStage } from '../../../core/schemas/enums.js';
import type { TaskContextFit } from '../../../core/schemas/enums.js';
import type {
  EngineEvent,
  ValidationStages,
  ValidationStageSkips,
} from '../../../engine/events/types.js';
import { formatDuration } from '../../../utils/format-time.js';
import { formatTruncatedList } from '../../../core/formatting.js';

export function formatTaskStartedValue(
  event: Extract<EngineEvent, { type: 'task_started' }>,
): string {
  const parts = [`${event.file} (${event.action})`];
  const toolLabel = formatToolModel(event.tool, event.model);
  if (toolLabel) parts.push(toolLabel);
  if (event.implementerProfile) parts.push(`profile ${event.implementerProfile}`);
  if (event.contextFit) {
    parts.push(
      `fit ${formatEventContextFit(event.contextFit, event.estimatedTokens, event.contextLength)}`,
    );
  }
  if (event.currentCodeContextMode && event.currentCodeContextMode !== 'none') {
    parts.push(`code ${event.currentCodeContextMode}`);
  }
  if (event.costPosture) parts.push(`cost ${event.costPosture}`);
  return parts.join(' · ');
}

export function formatExternalChangesValue(
  event: Extract<EngineEvent, { type: 'paused_external_changes' }>,
): string {
  if (!event.conflict) {
    return event.selectedAction
      ? `External changes detected · ${event.selectedAction}`
      : 'External changes detected';
  }

  const filesLabel = formatTruncatedList(event.conflict.files, 3) || 'no files';
  const tasksLabel =
    event.conflict.affectedTaskIds.length > 0
      ? ` · tasks ${event.conflict.affectedTaskIds.join(', ')}`
      : '';
  const actionLabel = event.selectedAction ? ` · ${event.selectedAction}` : '';

  return `${event.conflict.kind} · ${filesLabel}${tasksLabel}${actionLabel}`;
}

export function validationRow(event: Extract<EngineEvent, { type: 'validate' }>): string {
  const stageText = ValidationStageSchema.options
    .map((stage) => `${stage} ${validationStageSymbol(event.stages, stage, event.skipped)}`)
    .join(' ');
  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';
  return `validate ${stageText}${dur}`;
}

function formatEventContextFit(
  contextFit: TaskContextFit,
  estimatedTokens: number | undefined,
  contextLength: number | undefined,
): string {
  const tokenLabel =
    contextLength === undefined
      ? `${estimatedTokens ?? '?'} tok`
      : `${estimatedTokens ?? '?'}/${contextLength} tok`;
  return `${contextFit} ${tokenLabel}`;
}

function validationStageSymbol(
  stages: ValidationStages,
  stage: ValidationStage,
  skipped: ValidationStageSkips | undefined,
): string {
  if (skipped?.[stage]) return '–';
  return stages[stage] ? '✓' : '○';
}
