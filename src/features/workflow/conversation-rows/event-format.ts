import { formatToolModel } from '../../../core/model-display.js';
import { baseSplit } from '../../../core/review/base-split.js';
import { fixCheckVerdict } from '../../../core/review/fix-task.js';
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
import { formatContextLength } from '../../../core/formatting.js';
import { glyph } from '../../../lib/glyphs.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { formatUsageTokens } from '../usage-details-model.js';
import { suiteStageText } from '../display/phase-verb.js';
import type { ConversationRowSegment, ConversationRowTone } from './types.js';

const NOT_RUN = 'not\u00a0run';

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

// One flat string could not show which stage failed without being read word by word, and it wrapped
// mid-stage. Each stage is its own toned segment now, and dropping the command keeps the row on one
// line at every width — the failing stage's command moves to the error block below it.
export function validationSummarySegments(
  event: Extract<EngineEvent, { type: 'validate' }>,
): ConversationRowSegment[] {
  const segments: ConversationRowSegment[] = [{ text: 'Validate', tone: 'textDim' }];
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

// A wrap never splits a clock: `3m 0s` keeps its space as a no-break space.
function rowDuration(ms: number): string {
  return formatDuration(ms).replaceAll(' ', '\u00a0');
}

export function fullSuiteRow(event: Extract<EngineEvent, { type: 'full_suite' }>): string {
  const label = suiteStageText({
    id: event.id,
    moment: event.moment,
    command: truncateTerminalDisplayText(event.command, 48),
  });
  // Why a command did not run or was refused; a session from before reviewer checks has none.
  const detail = event.detail === undefined ? '' : `${SOFT_SEP}${firstLine(event.detail)}`;
  if (event.status === 'running') return `${label}${SOFT_SEP}running`;
  if (event.status === 'not-run') return `${label}${SOFT_SEP}${NOT_RUN}${detail}`;
  if (event.status === 'refused') return `${label}${SOFT_SEP}refused${detail}`;
  if (
    event.moment === 'brief' &&
    event.own !== undefined &&
    event.ownLeft !== undefined &&
    event.others !== undefined
  ) {
    return [
      label,
      ...fixCheckVerdict({
        own: event.own,
        ownLeft: event.ownLeft,
        others: event.others,
        proven: event.proven ?? true,
      }),
      ...(event.duration === undefined ? [] : [rowDuration(event.duration)]),
    ].join(SOFT_SEP);
  }
  const split =
    event.moment === 'base' &&
    event.passed === false &&
    event.newFailures !== undefined &&
    event.preExisting !== undefined
      ? baseSplit({
          newFailures: event.newFailures,
          preExisting: event.preExisting,
          notVerified: event.notVerified,
          reason: event.detail === undefined ? undefined : firstLine(event.detail),
        })
      : null;
  const verdict =
    split?.verdict ??
    (event.moment === 'base'
      ? event.passed === true
        ? 'passes at the run base'
        : 'red at the run base too'
      : event.passed === true
        ? 'passed'
        : 'failed');
  const dur = event.duration === undefined ? '' : `${SOFT_SEP}${rowDuration(event.duration)}`;
  // The clock follows the verdict, as on every other row; the reason a red is pre-existing, or not
  // verified at the run base, follows it.
  const why = split === null || split.why === null ? '' : `${SOFT_SEP}${split.why}`;
  return `${label}${SOFT_SEP}${verdict}${dur}${why}`;
}

// A red reviewer or fix check is an error. A red base re-run is an error when new failures remain.
// All-pre-existing failures, failures not verified at the run base (the red workspace row and its
// pending input carry them; the reviewer decides) and older base rows stay warning. Refused
// commands also stay warning.
export function fullSuiteTone(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
): ConversationRowTone {
  if (event.status === 'refused') return 'warning';
  if (event.status !== 'done' || event.passed === true) return 'textDim';
  return event.moment === 'base' && (event.newFailures === undefined || event.newFailures === 0)
    ? 'warning'
    : 'error';
}

/**
 * The headline of the commands the reviewer chose before a review, of the checks being off, or of
 * a chosen plan none of whose commands ran.
 */
export function reviewChecksRow(event: Extract<EngineEvent, { type: 'review_checks' }>): string {
  if (event.status === 'off') {
    return ['End-of-run checks', 'off', 'no reviewer check ran'].join(SOFT_SEP);
  }
  if (event.status === 'skipped') {
    return [
      'Reviewer checks',
      `${NOT_RUN} ${(event.commands ?? []).map((command) => command.id).join(', ')}`,
      firstLine(event.reason ?? 'no reason given'),
    ].join(SOFT_SEP);
  }
  const chosen = event.commands?.length ?? 0;
  const declined = event.declined?.length ?? 0;
  if (chosen === 0) {
    return [
      'Reviewer checks',
      'chose\u00a0none',
      firstLine(event.reason ?? 'no reason given'),
    ].join(SOFT_SEP);
  }
  const counts = [`chose ${chosen}`, ...(declined > 0 ? [`declined ${declined}`] : [])];
  return ['Reviewer checks', ...counts].join(SOFT_SEP);
}

/** One row per test the reviewer declined to run, with the reason it gave. */
export function reviewChecksDeclinedRows(
  event: Extract<EngineEvent, { type: 'review_checks' }>,
): string[] {
  return (event.declined ?? []).map((entry) =>
    ['declined', entry.target, firstLine(entry.reason)].join(SOFT_SEP),
  );
}

export function reviewChecksTone(
  event: Extract<EngineEvent, { type: 'review_checks' }>,
): ConversationRowTone {
  return event.status === 'planned' ? 'textDim' : 'warning';
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
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
