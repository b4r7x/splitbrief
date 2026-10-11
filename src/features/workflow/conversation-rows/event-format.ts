import { baseSplit } from '../../../core/review/base-split.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { fixCheckVerdict } from '../../../core/review/fix-task.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { ValidationStageSchema, type ValidationStage } from '../../../core/schemas/enums.js';
import type { TaskContextFit } from '../../../core/schemas/enums.js';
import type {
  EngineEvent,
  ValidationStages,
  ValidationStageSkips,
} from '../../../engine/events/types.js';
import { formatDuration } from '../../../utils/format-time.js';
import { formatContextLength } from '../../../core/formatting.js';
import { glyph } from '../../../lib/glyphs.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { formatUsageTokens } from '../usage-details-model.js';
import { suiteStageParts } from '../display/phase-verb.js';
import { formatRecordedSeatIdentity } from '../display/recorded-seat-identity.js';
import type { ConversationRowSegment, ConversationRowTone } from './types.js';

const NOT_RUN = 'not\u00a0run';

// The value's own facts, one label each. A label can carry the separator inside it — the tool and
// its model are one label — so callers that lay the value out themselves need the parts, not the
// joined string, or a wrap cannot tell one label's ` · ` from another's.
export function formatTaskStartedParts(
  event: Extract<EngineEvent, { type: 'task_started' }>,
): ConversationRowSegment[] {
  const parts: ConversationRowSegment[] = [
    { text: `${event.file} (${event.action})`, tone: 'textDim' },
  ];
  const identity = formatRecordedSeatIdentity({
    runnerName: event.tool,
    model: event.model,
    axes: event.axes,
    backendKind: event.backendKind,
    role: CREW_SEAT_ROLES.build,
  });
  if (identity !== null) parts.push({ text: identity, tone: CREW_SEAT_ROLES.build });
  if (event.contextFit && event.contextFit !== 'fits') {
    parts.push({
      text: formatEventContextFit(event.contextFit, event.estimatedTokens, event.contextLength),
      tone: 'textDim',
    });
  }
  if (event.currentCodeContextMode && event.currentCodeContextMode !== 'none') {
    parts.push({ text: `code ${event.currentCodeContextMode}`, tone: 'textDim' });
  }
  return parts;
}

// One flat string could not show which stage failed without being read word by word, and it wrapped
// mid-stage. Each stage is its own toned segment now, and dropping the command keeps the row on one
// line at every width — the failing stage's command moves to the error block below it.
export function validationSummarySegments(
  event: Extract<EngineEvent, { type: 'validate' }>,
): ConversationRowSegment[] {
  if (event.status === 'stopped')
    return [
      { text: 'Validate', tone: 'textDim' },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: 'stopped', tone: stateTone('attention') },
    ];
  const segments: ConversationRowSegment[] = [{ text: 'Validate', tone: 'textDim' }];
  for (const stage of ValidationStageSchema.options) {
    const state = validationStageSymbol(event, event.stages, stage, event.skipped);
    segments.push(
      { text: '  ', tone: 'textDim' },
      { text: stageGlyph(state), tone: stageTone(state) },
      { text: ` ${stage}`, tone: 'textDim' },
    );
  }
  if (event.duration) {
    segments.push(
      { text: '  ', tone: 'textDim' },
      { text: formatDuration(event.duration), tone: 'textDim' },
    );
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
  if (state === 'passed') return stateTone('passed');
  if (state === 'failed') return stateTone('failed');
  // The task did not break this gate, and the run was accepted with it red, so the cross is not
  // this task's failure to answer for.
  if (state === 'exempt') return stateTone('attention');
  if (state === 'running') return stateTone('running');
  return stateTone('pending');
}

// A wrap never splits a clock: `3m 0s` keeps its space as a no-break space.
function rowDuration(ms: number): string {
  return formatDuration(ms).replaceAll(' ', '\u00a0');
}

export function fullSuiteSegments(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
): ConversationRowSegment[] {
  const lead = suiteStageParts(
    {
      ...event,
      command: truncateTerminalDisplayText(event.command, 48),
    },
    'transcript',
  );
  const append = (parts: readonly ConversationRowSegment[]): ConversationRowSegment[] => [
    ...lead,
    ...separatedSegments(parts),
  ];
  const detail: ConversationRowSegment[] =
    event.detail === undefined ? [] : [{ text: firstLine(event.detail), tone: 'textDim' }];
  if (event.status === 'running') return append([{ text: 'running', tone: fullSuiteTone(event) }]);
  if (event.status === 'stopped') return append([{ text: 'stopped', tone: fullSuiteTone(event) }]);
  if (event.status === 'not-run')
    return append([{ text: NOT_RUN, tone: fullSuiteTone(event) }, ...detail]);
  if (event.status === 'refused')
    return append([{ text: 'refused', tone: fullSuiteTone(event) }, ...detail]);
  if (
    event.moment === 'brief' &&
    event.own !== undefined &&
    event.ownLeft !== undefined &&
    event.others !== undefined
  ) {
    return append([
      ...fixCheckVerdict({
        own: event.own,
        ownLeft: event.ownLeft,
        others: event.others,
        proven: event.proven ?? true,
      }).map(
        (text, index): ConversationRowSegment => ({
          text,
          tone: index === (event.proven === false ? 1 : 0) ? fullSuiteTone(event) : 'textDim',
        }),
      ),
      ...(event.duration === undefined
        ? []
        : [{ text: rowDuration(event.duration), tone: 'textDim' as const }]),
    ]);
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
        ? event.scenario === undefined
          ? 'passed'
          : 'rendered'
        : 'failed');
  // The clock follows the verdict, as on every other row; the reason a red is pre-existing, or not
  // verified at the run base, follows it.
  return append([
    { text: verdict, tone: fullSuiteTone(event) },
    ...(event.duration === undefined
      ? []
      : [{ text: rowDuration(event.duration), tone: 'textDim' as const }]),
    ...(split === null || split.why === null
      ? []
      : [{ text: split.why, tone: 'textDim' as const }]),
  ]);
}

function separatedSegments(parts: readonly ConversationRowSegment[]): ConversationRowSegment[] {
  return parts.flatMap((part): ConversationRowSegment[] => [
    { text: SOFT_SEP, tone: 'textDim' },
    part,
  ]);
}

// A red reviewer or fix check is an error. A red base re-run is an error when new failures remain.
// All-pre-existing failures, failures not verified at the run base (the red workspace row and its
// pending input carry them; the reviewer decides) and older base rows stay warning. Refused
// commands also stay warning.
export function fullSuiteTone(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
): ConversationRowTone {
  if (event.status === 'refused' || event.status === 'stopped' || event.status === 'not-run')
    return stateTone('attention');
  if (event.status === 'running') return stateTone('running');
  if (event.passed === true) return stateTone('passed');
  return event.moment === 'base' && (event.newFailures === undefined || event.newFailures === 0)
    ? stateTone('attention')
    : stateTone('failed');
}

export function reviewChecksSegments(
  event: Extract<EngineEvent, { type: 'review_checks' }>,
): ConversationRowSegment[] {
  const label: ConversationRowSegment[] = [
    { text: 'Reviewer', tone: CREW_SEAT_ROLES.review },
    { text: ' checks', tone: 'textDim' },
  ];
  if (event.status === 'off') {
    return [
      { text: 'End-of-run checks', tone: 'textDim' },
      ...separatedSegments([
        { text: 'off', tone: reviewChecksTone(event) },
        { text: 'no reviewer check ran', tone: 'textDim' },
      ]),
    ];
  }
  if (event.status === 'skipped') {
    return [
      ...label,
      { text: SOFT_SEP, tone: 'textDim' },
      { text: NOT_RUN, tone: reviewChecksTone(event) },
      {
        text: ` ${(event.commands ?? []).map((command) => command.id).join(', ')}`,
        tone: 'textDim',
      },
      ...separatedSegments([
        { text: firstLine(event.reason ?? 'no reason given'), tone: 'textDim' },
      ]),
    ];
  }
  const chosen = event.commands?.length ?? 0;
  const declined = event.declined?.length ?? 0;
  if (chosen === 0) {
    return [
      ...label,
      ...separatedSegments([
        { text: 'chose\u00a0none', tone: 'textDim' },
        { text: firstLine(event.reason ?? 'no reason given'), tone: 'textDim' },
      ]),
    ];
  }
  const counts = [`chose ${chosen}`, ...(declined > 0 ? [`declined ${declined}`] : [])];
  return [...label, ...separatedSegments(counts.map((text) => ({ text, tone: 'textDim' })))];
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
  return stateTone(event.status === 'planned' ? 'pending' : 'attention');
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
