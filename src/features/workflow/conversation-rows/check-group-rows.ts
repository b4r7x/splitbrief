import { fitKeyLegend } from '../../../core/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { stateTone, type StateMeaning } from '../../../core/theme/state-tone.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { segmentsForRowText } from '../../../utils/display-text/width.js';
import { formatDuration } from '../../../utils/format/time.js';
import { COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT } from './activity-batch-model.js';
import { fullSuiteOutcomeWord, fullSuiteTime, fullSuiteTone } from './event-format.js';
import { fullSuiteRowBlock } from './event-rows/execution.js';
import { foldRow, foldRowKey } from './fold-row.js';
import { segmentedRow } from './row-format/rows.js';
import { rowLeadingCells } from './row-markers.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowSegment,
  ConversationRowTone,
} from './types.js';

type CheckEvent = EngineEventOf<'full_suite'>;

interface GroupedCheck {
  check: CheckEvent;
  index: number;
  tone: ConversationRowTone;
}

/** The tones whose counts lead the header, the most telling first. */
const TELLING_TONES: readonly ConversationRowTone[] = [stateTone('failed'), stateTone('attention')];

/** The key the fold state of a check group is stored under: the index of its first event. */
export function checkGroupKey(firstIndex: number): string {
  return `checks:${firstIndex}`;
}

/**
 * A run of check rows as one group, in the grammar of an activity batch: a header that counts the
 * outcomes, one fold, and the rows that need the reader. A done group hides its green rows, a group
 * in progress shows its last rows, and an expanded group shows every row. Each row is the row the
 * check has on its own.
 */
export function checkGroupRowBlock(input: {
  checks: readonly CheckEvent[];
  firstIndex: number;
  expanded: boolean;
  /** The group ends a review that still runs, so it stays in progress between two checks. */
  open: boolean;
  width: number;
}): ConversationRowBlock {
  const { expanded, width } = input;
  const key = checkGroupKey(input.firstIndex);
  const checks = input.checks.map(
    (check, index): GroupedCheck => ({ check, index, tone: fullSuiteTone(check) }),
  );
  const inProgress = input.open || checks.some(({ check }) => check.status === 'running');
  const kept = inProgress
    ? checks.slice(-COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT)
    : checks.filter(({ tone }) => tone !== stateTone('passed'));
  const hidden = checks.length - kept.length;
  const label = inProgress
    ? `+${hidden} earlier`
    : kept.length === 0
      ? `+${hidden} checks`
      : `+${hidden} passed`;
  const shown = expanded ? checks : kept;
  const fold = hidden === 0 ? [] : [foldRow({ foldKey: key, expanded, hidden: [label], width })];
  const mark = groupMark(checks, inProgress);
  const rows = [
    headerRow(`${key}-header`, checks, mark, width),
    ...fold.map((row) =>
      shown.length === 0 ? { ...row, kind: 'activity-child-last' as const } : row,
    ),
    ...shown.flatMap(({ check, index }, position) =>
      checkRows(`${key}-check-${index}`, check, width, position === shown.length - 1),
    ),
  ];
  return {
    key,
    rowCount: rows.length,
    renderableUnits: checks.length,
    ...(mark === 'running' && { activeRowKey: `${key}-header` }),
    ...(hidden > 0 && { foldRowKey: foldRowKey(key) }),
    createRows: (windowStart, windowEnd) => rows.slice(windowStart, windowEnd),
  };
}

/**
 * A failure wins over in progress, in progress wins over a row that needs the reader, and that
 * wins over green.
 */
function groupMark(checks: readonly GroupedCheck[], inProgress: boolean): StateMeaning {
  const tones = checks.map(({ tone }) => tone);
  if (tones.includes(stateTone('failed'))) return 'failed';
  if (inProgress) return 'running';
  return tones.includes(stateTone('attention')) ? 'attention' : 'passed';
}

/** A header too narrow drops whole counts from the right, as a fold row does. */
function headerRow(
  key: string,
  checks: readonly GroupedCheck[],
  mark: StateMeaning,
  width: number,
): ConversationRow {
  const reused = checks.filter(({ check }) => check.reusedAt !== undefined).length;
  const times = checks.flatMap(({ check }) => fullSuiteTime(check) ?? []);
  const facts: ConversationRowSegment[] = [
    ...outcomeCounts(checks),
    ...(reused > 0 ? [{ text: `${reused} reused`, tone: 'textDim' as const }] : []),
    ...(times.length > 0
      ? [
          {
            text: formatDuration(times.reduce((sum, time) => sum + time, 0)),
            tone: 'textDim' as const,
          },
        ]
      : []),
  ];
  const segments: ConversationRowSegment[] = [
    { text: 'Checks', tone: 'text', bold: true },
    { text: '  ', tone: 'textDim' },
    ...facts.flatMap((fact, index): ConversationRowSegment[] => [
      ...(index === 0 ? [] : [{ text: SOFT_SEP, tone: 'textDim' as const }]),
      fact,
    ]),
  ];
  const full = segments.map((segment) => segment.text).join('');
  const budget = width - rowLeadingCells('activity');
  const text = truncateTerminalDisplayText(fitKeyLegend(full, budget) || full, budget);
  return {
    ...segmentedRow(key, segmentsForRowText(segments, text), 'activity'),
    markerTone: stateTone(mark),
    ...(mark === 'failed' && { doneAs: 'failed' as const }),
    ...(mark === 'attention' && { doneAs: 'attention' as const }),
  };
}

/**
 * One count per outcome word, in the most telling tone of its rows: failures, then what needs the
 * reader.
 */
function outcomeCounts(checks: readonly GroupedCheck[]): ConversationRowSegment[] {
  const counts = new Map<string, { count: number; tone: ConversationRowTone }>();
  for (const { check, tone } of checks) {
    const word = fullSuiteOutcomeWord(check);
    const seen = counts.get(word);
    counts.set(word, {
      count: (seen?.count ?? 0) + 1,
      tone: seen !== undefined && tellingRank(seen.tone) <= tellingRank(tone) ? seen.tone : tone,
    });
  }
  return [...counts]
    .map(([word, { count, tone }]): ConversationRowSegment => ({ text: `${count} ${word}`, tone }))
    .toSorted((left, right) => tellingRank(left.tone) - tellingRank(right.tone));
}

function tellingRank(tone: ConversationRowTone): number {
  const rank = TELLING_TONES.indexOf(tone);
  return rank === -1 ? TELLING_TONES.length : rank;
}

/**
 * The rows a check has on its own, as one branch of the tree. Its first line takes the branch mark.
 * The lines under a middle branch continue the tree; the lines under the last branch keep the
 * leading of the flat row.
 */
function checkRows(
  keyPrefix: string,
  check: CheckEvent,
  width: number,
  last: boolean,
): ConversationRow[] {
  const block = fullSuiteRowBlock(keyPrefix, check, width);
  if (block === null) return [];
  return block.createRows(0, block.rowCount).map((row, line) => {
    if (line === 0) return { ...row, kind: last ? 'activity-child-last' : 'activity-child' };
    return last ? row : { ...row, kind: 'callout-body' };
  });
}
