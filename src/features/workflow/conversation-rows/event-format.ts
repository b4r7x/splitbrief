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
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';

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
  if (event.routingReason) parts.push(`why ${event.routingReason}`);
  else if (event.costPosture) parts.push(`cost ${event.costPosture}`);
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
    .map((stage) => validationStageText(event, stage))
    .join(' ');
  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';
  return `validate ${stageText}${dur}`;
}

export function baselineValidationRow(
  event: Extract<EngineEvent, { type: 'validation_baseline' }>,
): string {
  const stageText = ValidationStageSchema.options
    .map((stage) => baselineValidationStageText(event, stage))
    .join(' ');
  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';
  return `baseline ${stageText}${dur}`;
}

function formatEventContextFit(
  contextFit: TaskContextFit,
  estimatedTokens: number | undefined,
  contextLength: number | undefined,
): string {
  if (contextFit === 'fits') return contextFit;
  const tokenLabel =
    contextLength === undefined
      ? `${estimatedTokens ?? '?'} tok`
      : `${estimatedTokens ?? '?'}/${contextLength} tok`;
  return `${contextFit} ${tokenLabel}`;
}

function validationStageSymbol(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stages: ValidationStages,
  stage: ValidationStage,
  skipped: ValidationStageSkips | undefined,
): string {
  if (skipped?.[stage]) return 'skipped';
  if (event.status === 'running' && event.activeStage === stage) return 'running';
  if (stages[stage]) return 'passed';
  if (event.status === 'done' && validationStageWasAttempted(event, stage, skipped)) {
    return 'failed';
  }
  return 'not-run';
}

function validationStageWasAttempted(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stage: ValidationStage,
  skipped: ValidationStageSkips | undefined,
): boolean {
  if (event.attempted !== undefined) return event.attempted[stage];
  return event.stages[stage] || skipped?.[stage] === true || !event.passed;
}

function validationStageText(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stage: ValidationStage,
): string {
  const command = event.commands?.[stage];
  const label =
    command === undefined ? stage : `${stage} (${truncateTerminalDisplayText(command, 48)})`;
  return `${label} ${validationStageSymbol(event, event.stages, stage, event.skipped)}`;
}

function baselineValidationStageSymbol(
  event: Extract<EngineEvent, { type: 'validation_baseline' }>,
  stage: ValidationStage,
): string {
  if (event.status === 'running' && event.activeStage === stage) return 'running';
  if (event.failing?.[stage]) return 'failed';
  if (event.stages[stage]) return 'passed';
  return 'not-run';
}

function baselineValidationStageText(
  event: Extract<EngineEvent, { type: 'validation_baseline' }>,
  stage: ValidationStage,
): string {
  const command = event.commands?.[stage];
  const label =
    command === undefined ? stage : `${stage} (${truncateTerminalDisplayText(command, 48)})`;
  return `${label} ${baselineValidationStageSymbol(event, stage)}`;
}
