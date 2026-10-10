import { ThemeText as Text, useTheme } from './theme.js';
import { Box } from 'ink';
import type { Theme } from '../core/theme/palette.js';
import type { TaskCompletionMethod } from '../core/schemas/enums.js';
import { getMethodDisplay } from '../core/sessions/display.js';
import { classifyTaskCompletionMethod } from '../core/task-completion.js';
import { SOFT_SEP } from '../core/separators.js';
import { formatDuration } from '../utils/format-time.js';
import {
  elidePathMiddle,
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../utils/display-text.js';
import { countNoun } from '../utils/pluralize.js';
import { glyph, type GlyphName } from '../lib/glyphs.js';
import { ROW_LEADING } from './row-leading.js';
import { formatTaskHeading, type WorkflowTask } from '../stores/workflow/tasks.js';

// The transcript's leading: the shared one-cell pad the hover bar paints into, then the marker and
// its trailing space. A brief's mark lands on column 1 with its title on column 3, the same shape a
// live row's header wears; the budget pays for every cell, measured off the leading itself.
function leadingWith(mark: string): string {
  return `${ROW_LEADING}${mark} `;
}
const LEADING_CELLS = getTerminalCellWidth(leadingWith(glyph('stageDone')));
// Two spaces divide the title from the detail run, `·` divides the run's own parts — the same two
// levels a running task header uses, so a settled row and a live row read the same way.
const TITLE_SEP = '  ';
const FAILED_SUFFIX = ' failed';

interface FittedDetailRun {
  head: string;
  tail: string[];
}

const SETTLED_METHODS = new Set([
  'passed',
  'consulted',
  'intermediate',
  'hint',
  'escalated',
  'escalated-intermediate',
  'escalated-hint',
  'escalated-full',
  'skipped',
]);

function isRetrySegment(segment: string): boolean {
  return /^\d+\s+(?:retry|retries)$/.test(segment);
}

function isSettledTail(tail: string[]): boolean {
  return tail.some((segment) => SETTLED_METHODS.has(segment));
}

function partitionSettledTail(tail: string[]): {
  file: string | undefined;
  retries: string | undefined;
  keptMeta: string[];
} {
  let file: string | undefined;
  let meta: string[];

  const first = tail[0];
  if (first !== undefined && !SETTLED_METHODS.has(first)) {
    file = first;
    meta = tail.slice(1);
  } else {
    file = undefined;
    meta = [...tail];
  }

  let retries: string | undefined;
  const keptMeta: string[] = [];

  for (const segment of meta) {
    if (retries === undefined && isRetrySegment(segment)) {
      retries = segment;
    } else {
      keptMeta.push(segment);
    }
  }

  return { file, retries, keptMeta };
}

export function fitDetailRun(
  task: Pick<WorkflowTask, 'id' | 'title'>,
  tail: string[],
  width: number,
  settled?: boolean,
  fileNote?: string,
  extraFiles?: string,
): FittedDetailRun {
  const head = formatTaskHeading(task);
  const budget = Math.max(0, width - LEADING_CELLS);
  const cells = (parts: string[]): number =>
    getTerminalCellWidth(parts.length === 0 ? head : `${head}${TITLE_SEP}${parts.join(SOFT_SEP)}`);
  const filePath = tail[0];
  if (filePath !== undefined && (isPresent(fileNote) || isPresent(extraFiles))) {
    const annotatedTail = [
      isPresent(fileNote) ? `${filePath} ${fileNote}` : filePath,
      extraFiles,
      ...tail.slice(1),
    ].filter(isPresent);
    if (cells(annotatedTail) <= budget) return { head, tail: annotatedTail };
  }

  const isSettled = settled ?? isSettledTail(tail);
  if (!isSettled) {
    const segments = [...tail];
    while (segments.length > 1 && cells(segments) > budget) segments.pop();
    if (cells(segments) <= budget) return { head, tail: segments };

    const only = segments[0];
    const room = budget - getTerminalCellWidth(head) - TITLE_SEP.length;
    if (only !== undefined && room > 0) {
      return { head, tail: [truncateTerminalDisplayTextMiddle(only, room)] };
    }
    return { head: formatTaskHeading(task, budget), tail: [] };
  }

  if (cells(tail) <= budget) return { head, tail };

  const skipIndex = tail.indexOf('skipped');
  if (skipIndex >= 0 && tail.length > skipIndex + 1) {
    const withoutReason = tail.slice(0, skipIndex + 1);
    const reason = tail[skipIndex + 1];
    const room = budget - cells(withoutReason) - getTerminalCellWidth(SOFT_SEP);
    if (reason !== undefined && room > 0) {
      const shortenedReason = truncateTerminalDisplayText(reason, room);
      if (shortenedReason !== '…') return { head, tail: [...withoutReason, shortenedReason] };
    }
    return fitDetailRun(task, withoutReason, width, true);
  }

  const { file, retries, keptMeta } = partitionSettledTail(tail);

  const tailWithoutRetries = [file, ...keptMeta].filter(isPresent);
  if (retries !== undefined && cells(tailWithoutRetries) <= budget) {
    return { head, tail: tailWithoutRetries };
  }

  if (file !== undefined) {
    const keptMetaWidth =
      keptMeta.length === 0
        ? 0
        : getTerminalCellWidth(SOFT_SEP) + getTerminalCellWidth(keptMeta.join(SOFT_SEP));
    const room = budget - getTerminalCellWidth(head) - TITLE_SEP.length - keptMetaWidth;
    if (room > 0) {
      const shortenedFile = elidePathMiddle(file, room);
      return { head, tail: [shortenedFile, ...keptMeta] };
    }
  }

  if (cells(keptMeta) <= budget) {
    return { head, tail: keptMeta };
  }

  const keptMetaWidth =
    keptMeta.length === 0 ? 0 : TITLE_SEP.length + getTerminalCellWidth(keptMeta.join(SOFT_SEP));
  const headBudget = Math.max(0, budget - keptMetaWidth);
  if (headBudget < getTerminalCellWidth(task.id) + 2) {
    return { head: formatTaskHeading(task, budget), tail: [] };
  }
  return { head: formatTaskHeading(task, headBudget), tail: keptMeta };
}

/**
 * What a ledger row is reporting. `settled` is a brief that reached a verdict, `halted` is the one
 * the run stopped inside, `pending` is a brief that never started, and `stage` is a settled run
 * stage listed between briefs. All four share one marker column.
 */
export type TaskSummaryState =
  | Readonly<{ kind: 'settled'; method: TaskCompletionMethod }>
  | Readonly<{ kind: 'halted'; tone: 'cancelled' | 'failed'; word: string }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{
      kind: 'stage';
      outcome: 'passed' | 'failed' | 'no-verdict' | 'stopped';
      detail: readonly string[];
    }>;

interface TaskSummaryProps {
  id: string;
  title: string;
  state: TaskSummaryState;
  width: number;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  fileNote?: string | undefined;
  extraFiles?: string | undefined;
  reason?: string | undefined;
  /** What a halted row still owes the reader: `2 partial files`. */
  note?: string | undefined;
  focused?: boolean | undefined;
}

interface MarkerSpec {
  name: GlyphName;
  color: string | undefined;
}

function settledMarker(method: TaskCompletionMethod, t: Theme): MarkerSpec {
  if (method === 'failed') return { name: 'statusFailed', color: t.error };
  if (method === 'skipped') return { name: 'statusSkipped', color: t.textDim };
  // A brief that needed a bigger seat did not pass on the one it was given, and the sidebar says so
  // with the same triangle in warning.
  if (classifyTaskCompletionMethod(method) === 'escalated') {
    return { name: 'statusEscalated', color: t.warning };
  }
  return { name: 'stageDone', color: t.success };
}

function markerSpec(state: TaskSummaryState, t: Theme): MarkerSpec {
  if (state.kind === 'pending') return { name: 'statusPending', color: t.textDim };
  if (state.kind === 'stage') {
    if (state.outcome === 'stopped') return { name: 'statusCancelled', color: t.warning };
    return state.outcome === 'failed' || state.outcome === 'no-verdict'
      ? { name: 'statusFailed', color: t.error }
      : { name: 'stageDone', color: t.success };
  }
  if (state.kind === 'halted') {
    return state.tone === 'failed'
      ? { name: 'statusFailed', color: t.error }
      : { name: 'statusCancelled', color: t.warning };
  }
  return settledMarker(state.method, t);
}

export function TaskSummary({
  id,
  title,
  state,
  width,
  retries,
  duration,
  file,
  fileNote,
  extraFiles,
  reason,
  note,
  focused,
}: TaskSummaryProps) {
  const t = useTheme();
  const safeFile = file === undefined ? undefined : sanitizeTerminalDisplayText(file);
  const safeFileNote = fileNote === undefined ? undefined : sanitizeTerminalDisplayText(fileNote);
  const safeExtraFiles =
    extraFiles === undefined ? undefined : sanitizeTerminalDisplayText(extraFiles);
  const safeReason = reason === undefined ? undefined : sanitizeTerminalDisplayText(reason);
  const safeNote = note === undefined ? undefined : sanitizeTerminalDisplayText(note);
  const marker = markerSpec(state, t);
  // One leading for every row kind — the transcript's padding then the marker slot — so a settled
  // brief and a pending one line their marks up in the same column, and that column is the one the
  // live transcript uses.
  //
  // Focus paints the bar into the padding cell and keeps the mark, the way a focused transcript row
  // does, so the mark never leaves the line. The bar is `text`, not `accent`: this glyph also marks
  // the live row in the sidebar and the focused row in the transcript, and one glyph wearing three
  // colours across three panes reads as three different affordances.
  const leading = leadingWith(glyph(marker.name));
  const markerSlot =
    focused === true ? (
      <Text>
        <Text color={t.text} bold>
          {glyph('liveBar')}
        </Text>
        <Text color={marker.color}>{leading.slice(1)}</Text>
      </Text>
    ) : (
      <Text color={marker.color}>{leading}</Text>
    );

  const failed =
    (state.kind === 'settled' && state.method === 'failed') ||
    (state.kind === 'stage' && state.outcome === 'failed');
  const quiet =
    failed || state.kind === 'pending' || (state.kind === 'settled' && state.method === 'skipped');
  const fitted = fitDetailRun(
    { id, title },
    detailRun({ state, safeFile, safeReason, safeNote, retries, duration, t }),
    width - (failed ? FAILED_SUFFIX.length : 0),
    state.kind === 'settled',
    isPresent(safeFile) ? safeFileNote : undefined,
    isPresent(safeFile) ? safeExtraFiles : undefined,
  );

  return (
    <Box>
      <Text wrap="truncate-end">
        {markerSlot}
        <Text color={quiet ? t.textDim : t.text}>{fitted.head}</Text>
        {failed && <Text color={t.dimError}>{FAILED_SUFFIX}</Text>}
        {fitted.tail.length > 0 && (
          <Text color={t.textDim}>
            {TITLE_SEP}
            {fitted.tail.join(SOFT_SEP)}
          </Text>
        )}
      </Text>
    </Box>
  );
}

function detailRun(input: {
  state: TaskSummaryState;
  safeFile: string | undefined;
  safeReason: string | undefined;
  safeNote: string | undefined;
  retries: number | undefined;
  duration: number | undefined;
  t: Theme;
}): string[] {
  const { state, safeFile, safeReason, safeNote, retries, duration } = input;
  if (state.kind === 'pending') return [];
  if (state.kind === 'stage') return state.detail.map((part) => sanitizeTerminalDisplayText(part));
  if (state.kind === 'halted') {
    return [safeFile, state.word, safeNote].filter(isPresent);
  }
  if (state.method === 'failed') return [safeFile].filter(isPresent);
  if (state.method === 'skipped') return [safeFile, 'skipped', safeReason].filter(isPresent);
  const meta = [getMethodDisplay(state.method, input.t).text];
  if (retries !== undefined && retries > 0) meta.push(countNoun(retries, 'retry', 'retries'));
  if (duration != null) meta.push(formatDuration(duration));
  return [safeFile, ...meta].filter(isPresent);
}

function isPresent(part: string | undefined): part is string {
  return part !== undefined && part !== '';
}
