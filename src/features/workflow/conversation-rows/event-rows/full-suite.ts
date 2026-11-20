import { baseSplit, baseSplitNames } from '../../../../core/review/base-split.js';
import { fixCheckVerdict } from '../../../../core/review/fix/checks.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { reusedNote } from '../../../../core/validation/reused-note.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { truncateTerminalDisplayText } from '../../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { formatDuration } from '../../../../utils/format/time.js';
import { suiteStageParts } from '../../display/phase-verb.js';
import { wrapWidthFor } from '../row-format/markers.js';
import type { ConversationRowSegment, ConversationRowTone } from '../types.js';

const NOT_RUN = 'not\u00a0run';
const MIN_SUITE_COMMAND_CELLS = 16;

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
  return available < MIN_SUITE_COMMAND_CELLS
    ? event.command
    : truncateTerminalDisplayText(event.command, available);
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

export function separatedSegments(
  parts: readonly ConversationRowSegment[],
): ConversationRowSegment[] {
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

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
