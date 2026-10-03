import { formatToolModel } from '../../../core/model-display.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { ValidationStageSchema, type ValidationStage } from '../../../core/schemas/enums.js';
import type { TaskContextFit } from '../../../core/schemas/enums.js';
import type {
  EngineEvent,
  ValidationStages,
  ValidationStageSkips,
} from '../../../engine/events/types.js';
import { resolveModelDisplayName } from '../../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { formatDuration } from '../../../utils/format-time.js';
import { formatContextLength, formatTruncatedList } from '../../../core/formatting.js';
import { glyph } from '../../../lib/glyphs.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { userEditConflictRelation } from '../../../core/recovery/user-edit-conflict-words.js';
import { formatUsageTokens } from '../usage-details-model.js';
import type { ConversationRowSegment, ConversationRowTone } from './types.js';

export function formatTaskStartedValue(
  event: Extract<EngineEvent, { type: 'task_started' }>,
): string {
  return formatTaskStartedParts(event).join(SOFT_SEP);
}

// The value's own facts, one label each. A label can carry the separator inside it — the tool and
// its model are one label — so callers that lay the value out themselves need the parts, not the
// joined string, or a wrap cannot tell one label's ` · ` from another's.
export function formatTaskStartedParts(
  event: Extract<EngineEvent, { type: 'task_started' }>,
): string[] {
  const parts = [`${event.file} (${event.action})`];
  const displayName =
    event.tool === undefined || event.model === undefined
      ? undefined
      : resolveModelDisplayName({
          providerId: event.tool,
          model: event.model,
          role: 'implementer',
          cache: modelCacheStore,
        });
  const toolLabel = formatToolModel({
    tool: event.tool,
    model: event.model,
    displayName,
  });
  if (toolLabel) parts.push(toolLabel);
  // The recovery panel names this value `Worker`. The routing sentence (`Selected profile default
  // (fits, estimated …)`) restates the worker and the fit, so it stays in the run log.
  if (event.implementerProfile) parts.push(`worker ${event.implementerProfile}`);
  if (event.contextFit && event.contextFit !== 'fits') {
    parts.push(formatEventContextFit(event.contextFit, event.estimatedTokens, event.contextLength));
  }
  if (event.currentCodeContextMode && event.currentCodeContextMode !== 'none') {
    parts.push(`code ${event.currentCodeContextMode}`);
  }
  return parts;
}

// The verdict and the file list are two lines, the way the recovery panel puts its files under its
// headline: in one line the list wrapped into the verdict and split it.
export function formatExternalChangesValue(
  event: Extract<EngineEvent, { type: 'paused_external_changes' }>,
): string {
  // Only `continue-unrelated` lets the brief start. Every other answer raises a recovery issue,
  // so the card must not name an action that the recovery panel offers next.
  const outcome =
    event.selectedAction === undefined
      ? undefined
      : event.selectedAction === 'continue-unrelated'
        ? 'run continued'
        : 'recovery needed';
  const verdict = [
    event.conflict
      ? userEditConflictRelation({
          kind: event.conflict.kind,
          affectedTaskIds: event.conflict.affectedTaskIds,
          currentTaskId: event.conflict.currentTaskId,
        })
      : 'External changes detected',
    ...(outcome === undefined ? [] : [outcome]),
  ].join(' · ');
  const files = event.conflict ? formatTruncatedList(event.conflict.files, 3) : '';
  return files === '' ? verdict : `${verdict}\n${files}`;
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

// A glyph is enough to say a gate passed; it is not enough to say one never ran, or that the one
// that failed was already red before the task started. Those two verdicts say themselves in the
// words the evidence ledger uses for them, so the row and the ledger read alike.
export function validationStageNotes(event: Extract<EngineEvent, { type: 'validate' }>): string[] {
  return ValidationStageSchema.options.flatMap((stage) => {
    const state = validationStageSymbol(event, event.stages, stage, event.skipped);
    if (state === 'exempt') return [`${stage} pre-existing failure`];
    if (state !== 'skipped') return [];
    const reason = event.skippedReason?.[stage];
    return [reason === undefined ? `${stage} skipped` : `${stage} skipped (${reason})`];
  });
}

function stageGlyph(state: ValidationStageState): string {
  if (state === 'passed') return glyph('check');
  if (state === 'failed' || state === 'exempt') return glyph('statusFailed');
  if (state === 'running') return glyph('statusInProgress');
  if (state === 'skipped') return glyph('statusSkipped');
  return glyph('statusPending');
}

function stageTone(state: ValidationStageState): ConversationRowTone {
  if (state === 'passed') return 'success';
  if (state === 'failed') return 'error';
  // The task did not break this gate, and the run was accepted with it red, so the cross is not
  // this task's failure to answer for.
  if (state === 'exempt') return 'warning';
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
  if (estimatedTokens === undefined) return `context (${contextFit})`;
  const window = formatContextLength(contextLength);
  const share = window === '' ? '' : ` of ${window}`;
  return `~${formatUsageTokens(estimatedTokens)}${share} context tokens (${contextFit})`;
}

type ValidationStageState = 'passed' | 'failed' | 'exempt' | 'running' | 'skipped' | 'not-run';

function validationStageSymbol(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stages: ValidationStages,
  stage: ValidationStage,
  skipped: ValidationStageSkips | undefined,
): ValidationStageState {
  if (skipped?.[stage]) return 'skipped';
  if (event.status === 'running' && event.activeStage === stage) return 'running';
  if (stages[stage]) return 'passed';
  if (event.status === 'done' && validationStageWasAttempted(event, stage, skipped)) {
    // An exempt event is accepted only when every stage it failed was already failing at baseline.
    return event.exempt === true ? 'exempt' : 'failed';
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
