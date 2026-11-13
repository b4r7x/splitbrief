import { baseSplit, baseSplitNames } from '../../../core/review/base-split.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { fixCheckVerdict } from '../../../core/review/fix-task.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { reusedNote } from '../../../core/validation/reused-note.js';
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
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { formatUsageTokens } from '../usage-details-model.js';
import { suiteStageParts } from '../display/phase-verb.js';
import { formatRecordedSeatIdentity } from '../display/recorded-seat-identity.js';
import { wrapWidthFor } from './row-markers.js';
import type { ConversationRowSegment, ConversationRowTone } from './types.js';

const NOT_RUN = 'not\u00a0run';
const MAX_SUITE_COMMAND_CELLS = 48;
const MIN_SUITE_COMMAND_CELLS = 16;

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
  width: number,
): ConversationRowSegment[] {
  const detail: ConversationRowSegment[] =
    event.detail === undefined ? [] : [{ text: firstLine(event.detail), tone: 'textDim' }];
  // A reused result shows when its command ran, in place of the clock of a run; a wrap keeps it whole.
  const time = fullSuiteTime(event);
  const clock: ConversationRowSegment[] =
    time !== undefined
      ? [{ text: rowDuration(time), tone: 'textDim' }]
      : event.status === 'done' && event.reusedAt !== undefined
        ? [{ text: reusedNote(event.reusedAt).replaceAll(' ', '\u00a0'), tone: 'textDim' }]
        : [];
  const outcome = fullSuiteOutcome(event, detail);
  const lead = suiteStageParts(
    { ...event, command: suiteCommandForRow(event, outcome.verdict, clock, width) },
    'transcript',
  );
  return [...lead, ...separatedSegments([...outcome.verdict, ...clock, ...outcome.trail])];
}

function suiteCommandForRow(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
  verdict: readonly ConversationRowSegment[],
  clock: readonly ConversationRowSegment[],
  width: number,
): string {
  if (event.scenario !== undefined || event.command === '') return event.command;
  const leadCells = segmentCells(suiteStageParts({ ...event, command: '' }, 'transcript'));
  const reserved =
    leadCells +
    getTerminalCellWidth(SOFT_SEP) +
    segmentCells(separatedSegments([...verdict, ...clock]));
  const available = wrapWidthFor('message', width) - reserved;
  return truncateTerminalDisplayText(
    event.command,
    available < MIN_SUITE_COMMAND_CELLS
      ? MAX_SUITE_COMMAND_CELLS
      : Math.min(MAX_SUITE_COMMAND_CELLS, available),
  );
}

function segmentCells(segments: readonly ConversationRowSegment[]): number {
  return segments.reduce((total, segment) => total + getTerminalCellWidth(segment.text), 0);
}

/** The time a check's row shows: the clock of a done run, not of a result reused from an earlier run. */
export function fullSuiteTime(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
): number | undefined {
  return event.status === 'done' && event.reusedAt === undefined ? event.duration : undefined;
}

/**
 * The word a check's outcome reads as, from the words of its row: its status while it is not done,
 * then `passed`, `rendered`, `pre-existing`, `timed out` or `failed`. A re-run at the run base reads
 * `passes at the run base`, `pre-existing`, `timed out at the run base` or `red at the run base`. A
 * split or a fix check's counts say more on the row itself.
 */
export function fullSuiteOutcomeWord(event: Extract<EngineEvent, { type: 'full_suite' }>): string {
  if (event.status === 'not-run') return NOT_RUN;
  if (event.status !== 'done') return event.status;
  if (event.passed === true) {
    if (event.moment === 'base') return 'passes at the run base';
    return event.scenario === undefined ? 'passed' : 'rendered';
  }
  if (fullSuiteSplit(event)?.verdict === 'pre-existing') return 'pre-existing';
  if (event.moment === 'base')
    return event.timedOut === true ? 'timed out at the run base' : 'red at the run base';
  return event.timedOut === true ? 'timed out' : 'failed';
}

function fullSuiteSplit(event: Extract<EngineEvent, { type: 'full_suite' }>) {
  return (event.moment === 'pre-review' ||
    event.moment === 'base' ||
    event.moment === 'verify' ||
    event.moment === 'plan') &&
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
}

function fullSuiteOutcome(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
  detail: readonly ConversationRowSegment[],
): { verdict: ConversationRowSegment[]; trail: ConversationRowSegment[] } {
  if (event.status !== 'done')
    return {
      verdict: [{ text: fullSuiteOutcomeWord(event), tone: fullSuiteTone(event) }],
      trail: event.status === 'not-run' || event.status === 'refused' ? [...detail] : [],
    };
  if (
    event.moment === 'brief' &&
    event.own !== undefined &&
    event.ownLeft !== undefined &&
    event.others !== undefined
  ) {
    return {
      verdict: fixCheckVerdict({
        own: event.own,
        ownLeft: event.ownLeft,
        deferred: event.deferred ?? 0,
        deferredTo: event.deferredTo ?? [],
        others: event.others,
      }).map(
        (text, index): ConversationRowSegment => ({
          text,
          tone: index === 0 ? fullSuiteTone(event) : 'textDim',
        }),
      ),
      trail: [],
    };
  }
  const split = fullSuiteSplit(event);
  const verdict = split?.verdict ?? fullSuiteOutcomeWord(event);
  // The clock follows the verdict, as on every other row; the reason a red is pre-existing, or not
  // verified at the run base, follows it.
  return {
    verdict: [{ text: verdict, tone: fullSuiteTone(event) }],
    trail: [
      ...(split === null || split.why === null
        ? []
        : [{ text: split.why, tone: 'textDim' as const }]),
      ...(event.passed === false && event.command === '' ? detail : []),
    ],
  };
}

/**
 * The failing tests a split names, new and pre-existing, one row per test under the strip rather than on it, so a
 * long test name never cuts the verdict. Each side's label leads its first test, right-aligned
 * with the other side's label, so every test of both sides and every wrapped line hang in one
 * column.
 */
export function fullSuiteNameRows(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
): { text: string; indent: number; continuationIndent: number }[] {
  const sides = baseSplitNames(event);
  const labelWidth = Math.max(0, ...sides.map(({ side }) => side.length));
  const column = 2 + labelWidth + SOFT_SEP.length;
  return sides.flatMap(({ side, names }) => {
    const lead = `${side}${SOFT_SEP}`;
    return names.map((name, index) =>
      index === 0
        ? { text: `${lead}${name}`, indent: column - lead.length, continuationIndent: lead.length }
        : { text: name, indent: column, continuationIndent: 0 },
    );
  });
}

function separatedSegments(parts: readonly ConversationRowSegment[]): ConversationRowSegment[] {
  return parts.flatMap((part): ConversationRowSegment[] => [
    { text: SOFT_SEP, tone: 'textDim' },
    part,
  ]);
}

// A red reviewer, plan or fix check is an error, unless every failure is pre-existing: then a
// reviewer or verify check is a warning, and a plan check is a neutral note, as its brief passes. A
// red at the run base is a warning: it says only what the run base shows. In an older run the base
// row carried the split, and a red there was an error when new failures remained. Refused commands
// stay warning. A fix check that is off is a neutral note.
export function fullSuiteTone(
  event: Extract<EngineEvent, { type: 'full_suite' }>,
): ConversationRowTone {
  if (event.status === 'refused' || event.status === 'stopped' || event.status === 'not-run')
    return stateTone('attention');
  if (event.status === 'off') return 'textDim';
  if (event.status === 'running') return stateTone('running');
  if (event.passed === true) return stateTone('passed');
  if (event.moment === 'base') {
    return event.newFailures === undefined || event.newFailures === 0
      ? stateTone('attention')
      : stateTone('failed');
  }
  if (event.newFailures !== 0 || (event.notVerified ?? 0) !== 0) return stateTone('failed');
  if (event.moment === 'plan') return 'textDim';
  return event.moment === 'pre-review' || event.moment === 'verify'
    ? stateTone('attention')
    : stateTone('failed');
}

export function reviewChecksSegments(
  event: Extract<EngineEvent, { type: 'review_checks' }>,
): ConversationRowSegment[] {
  return [
    { text: 'End-of-run checks', tone: 'textDim' },
    ...separatedSegments(
      event.status === 'off'
        ? [
            { text: 'off', tone: stateTone('attention') },
            { text: 'no reviewer check ran', tone: 'textDim' },
          ]
        : [
            { text: 'none', tone: 'textDim' },
            { text: 'the plan names no project gate', tone: 'textDim' },
          ],
    ),
  ];
}

export function reviewNoneSegments(): ConversationRowSegment[] {
  return [
    { text: 'Review', tone: 'textDim' },
    ...separatedSegments([
      { text: 'none', tone: 'textDim' },
      { text: 'no seat reviewed this run', tone: 'textDim' },
    ]),
  ];
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
  // A brief over its window runs only with Prompt budget `auto`, where the tool handles its own
  // context, so the row shows the estimate alone.
  if (contextFit === 'overflow') return `~${formatUsageTokens(estimatedTokens)} context tokens`;
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
