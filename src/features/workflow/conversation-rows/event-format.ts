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
import { glyph } from '../../../lib/glyphs.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import type { ConversationRowSegment, ConversationRowTone } from './types.js';

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

// One flat string could not show which stage failed without being read word by word, and it wrapped
// mid-stage. Each stage is its own toned segment now, and dropping the command keeps the row on one
// line at every width — the failing stage's command moves to the error block below it.
export function validationSummarySegments(
  event: Extract<EngineEvent, { type: 'validate' }>,
): ConversationRowSegment[] {
  const segments: ConversationRowSegment[] = [{ text: 'validate', tone: 'textDim' }];
  for (const stage of ValidationStageSchema.options) {
    const state = validationStageSymbol(event, event.stages, stage, event.skipped);
    segments.push(
      { text: '  ' },
      { text: `${stageGlyph(state)} ${stage}`, tone: stageTone(state) },
    );
  }
  if (event.duration) {
    segments.push({ text: '  ' }, { text: formatDuration(event.duration), tone: 'textDim' });
  }
  return segments;
}

function stageGlyph(state: string): string {
  if (state === 'passed') return glyph('check');
  if (state === 'failed') return glyph('statusFailed');
  if (state === 'running') return glyph('statusInProgress');
  if (state === 'skipped') return glyph('statusSkipped');
  return glyph('statusPending');
}

function stageTone(state: string): ConversationRowTone {
  if (state === 'passed') return 'success';
  if (state === 'failed') return 'error';
  if (state === 'running') return 'info';
  return 'textDim';
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
