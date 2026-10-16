import { ThemeText as Text, useTheme } from './theme.js';
import { TextSpans } from './text-spans.js';
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
  segmentsForRowText,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../utils/display-text.js';
import { countNoun } from '../utils/pluralize.js';
import { glyph, type GlyphName } from '../lib/glyphs.js';
import { ROW_LEADING } from './row-leading.js';
import { formatTaskHeading, type WorkflowTask } from '../stores/workflow/tasks.js';
import { stateTone, type StateTone } from '../core/theme/state-tone.js';

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
  tail: DetailSpan[];
}

interface DetailSpan {
  text: string;
  tone: StateTone;
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

function isSettledTail(tail: DetailSpan[]): boolean {
  return tail.some((segment) => SETTLED_METHODS.has(segment.text));
}

function partitionSettledTail(tail: DetailSpan[]): {
  file: DetailSpan | undefined;
  retries: DetailSpan | undefined;
  keptMeta: DetailSpan[];
} {
  let file: DetailSpan | undefined;
  let meta: DetailSpan[];

  const first = tail[0];
  if (first !== undefined && !SETTLED_METHODS.has(first.text)) {
    file = first;
    meta = tail.slice(1);
  } else {
    file = undefined;
    meta = [...tail];
  }

  let retries: DetailSpan | undefined;
  const keptMeta: DetailSpan[] = [];

  for (const segment of meta) {
    if (retries === undefined && isRetrySegment(segment.text)) {
      retries = segment;
    } else {
      keptMeta.push(segment);
    }
  }

  return { file, retries, keptMeta };
}

export function fitDetailRun(
  task: Pick<WorkflowTask, 'id' | 'title'>,
  tail: DetailSpan[],
  width: number,
  settled?: boolean,
  fileNote?: string,
  extraFiles?: string,
): FittedDetailRun {
  const head = formatTaskHeading(task);
  const budget = Math.max(0, width - LEADING_CELLS);
  const tailText = (parts: DetailSpan[]): string => parts.map((part) => part.text).join(SOFT_SEP);
  const cells = (parts: DetailSpan[]): number =>
    getTerminalCellWidth(parts.length === 0 ? head : `${head}${TITLE_SEP}${tailText(parts)}`);
  // The `(action)` note is decoration and drops first. The `+N files` count is a fact about the
  // path it follows: it keeps its room while the path shortens, and it drops only with the path.
  const [filePath, ...meta] = tail;
  const count: DetailSpan | undefined =
    filePath !== undefined && isPresent(extraFiles)
      ? { text: extraFiles, tone: 'textDim' }
      : undefined;
  const counted =
    filePath === undefined ? tail : [filePath, ...(count === undefined ? [] : [count]), ...meta];
  if (filePath !== undefined && isPresent(fileNote)) {
    const annotatedTail = [
      { ...filePath, text: `${filePath.text} ${fileNote}` },
      ...counted.slice(1),
    ];
    if (cells(annotatedTail) <= budget) return { head, tail: annotatedTail };
  }
  if (cells(counted) <= budget) return { head, tail: counted };

  const isSettled = settled ?? isSettledTail(tail);
  if (!isSettled) {
    const segments = [...counted];
    while (segments.length > 1 && cells(segments) > budget) segments.pop();
    if (cells(segments) <= budget) return { head, tail: segments };

    const only = segments[0];
    const room = budget - getTerminalCellWidth(head) - TITLE_SEP.length;
    if (only !== undefined && room > 0) {
      return {
        head,
        tail: [{ ...only, text: truncateTerminalDisplayTextMiddle(only.text, room) }],
      };
    }
    return { head: formatTaskHeading(task, budget), tail: [] };
  }

  const skipIndex = counted.findIndex((part) => part.text === 'skipped');
  if (skipIndex >= 0 && counted.length > skipIndex + 1) {
    const withoutReason = counted.slice(0, skipIndex + 1);
    const reason = counted[skipIndex + 1];
    const room = budget - cells(withoutReason) - getTerminalCellWidth(SOFT_SEP);
    if (reason !== undefined && room > 0) {
      const shortenedReason = truncateTerminalDisplayText(reason.text, room);
      if (shortenedReason !== '…')
        return { head, tail: [...withoutReason, { ...reason, text: shortenedReason }] };
    }
    return fitDetailRun(
      task,
      tail.filter((part) => part !== reason),
      width,
      true,
      undefined,
      extraFiles,
    );
  }

  const { file, retries, keptMeta } = partitionSettledTail(tail);
  const afterFile = file !== undefined && count !== undefined ? [count, ...keptMeta] : keptMeta;

  const tailWithoutRetries = file === undefined ? keptMeta : [file, ...afterFile];
  if (retries !== undefined && cells(tailWithoutRetries) <= budget) {
    return { head, tail: tailWithoutRetries };
  }

  if (file !== undefined) {
    const afterFileWidth =
      afterFile.length === 0
        ? 0
        : getTerminalCellWidth(SOFT_SEP) + getTerminalCellWidth(tailText(afterFile));
    const room = budget - getTerminalCellWidth(head) - TITLE_SEP.length - afterFileWidth;
    if (room > 0) {
      // A bare `…` names no file, so the path and its count drop together.
      const shortenedFile = elidePathMiddle(file.text, room);
      if (shortenedFile !== '…')
        return { head, tail: [{ ...file, text: shortenedFile }, ...afterFile] };
    }
  }

  if (cells(keptMeta) <= budget) {
    return { head, tail: keptMeta };
  }

  const keptMetaWidth =
    keptMeta.length === 0 ? 0 : TITLE_SEP.length + getTerminalCellWidth(tailText(keptMeta));
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
      headingParts: Readonly<{
        id: readonly TaskSummaryHeadingPart[];
        title: TaskSummaryHeadingPart | null;
      }>;
      detail: readonly string[];
    }>;

export interface TaskSummaryHeadingPart {
  readonly text: string;
  readonly tone: StateTone | 'planner' | 'implementer' | 'reviewer' | 'text';
}

interface TaskSummaryBaseProps {
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

type TaskSummaryProps = TaskSummaryBaseProps &
  (
    | { state: Extract<TaskSummaryState, { kind: 'stage' }>; id?: never; title?: never }
    | { state: Exclude<TaskSummaryState, { kind: 'stage' }>; id: string; title: string }
  );

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

export function TaskSummary(props: TaskSummaryProps) {
  const { state, width, retries, duration, file, fileNote, extraFiles, reason, note, focused } =
    props;
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
    state.kind === 'pending' || (state.kind === 'settled' && state.method === 'skipped');
  let headingParts: readonly TaskSummaryHeadingPart[] | null = null;
  let taskHeading: Pick<WorkflowTask, 'id' | 'title'>;
  if (props.id !== undefined) {
    taskHeading = { id: props.id, title: props.title };
  } else {
    const idParts = props.state.headingParts.id.map((part) => ({
      ...part,
      text: sanitizeTerminalDisplayText(part.text),
    }));
    const titlePart = props.state.headingParts.title;
    const title = titlePart === null ? '' : sanitizeTerminalDisplayText(titlePart.text);
    taskHeading = { id: idParts.map((part) => part.text).join(''), title };
    headingParts = [
      ...idParts,
      ...(titlePart === null
        ? []
        : [
            {
              text: ' ',
              tone: titlePart.tone === 'text' ? ('text' as const) : ('textDim' as const),
            },
            { ...titlePart, text: title },
          ]),
    ];
  }
  const fitted = fitDetailRun(
    taskHeading,
    detailRun({ state, safeFile, safeReason, safeNote, retries, duration, t }),
    width - (failed ? FAILED_SUFFIX.length : 0),
    // A halted brief with a file fits the way a settled one does: its state word and note keep
    // their room, and the path and its count go first.
    state.kind === 'settled' || (state.kind === 'halted' && isPresent(safeFile)),
    isPresent(safeFile) ? safeFileNote : undefined,
    isPresent(safeFile) ? safeExtraFiles : undefined,
  );

  return (
    <Box>
      <Text wrap="truncate-end">
        {markerSlot}
        {headingParts !== null ? (
          <TextSpans parts={segmentsForRowText(headingParts, fitted.head)} />
        ) : (
          <Text color={quiet ? t.textDim : t.text}>{fitted.head}</Text>
        )}
        {failed && <Text color={t[stateTone('failed')]}>{FAILED_SUFFIX}</Text>}
        {fitted.tail.length > 0 && (
          <Text color={t.textDim}>
            {TITLE_SEP}
            {fitted.tail.map((part, index) => (
              <Text key={index}>
                {index > 0 && <Text color={t.textDim}>{SOFT_SEP}</Text>}
                <Text color={t[part.tone]}>{part.text}</Text>
              </Text>
            ))}
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
}): DetailSpan[] {
  const { state, safeFile, safeReason, safeNote, retries, duration } = input;
  if (state.kind === 'pending') return [];
  if (state.kind === 'stage')
    return state.detail.map((part) => ({
      text: sanitizeTerminalDisplayText(part),
      tone: 'textDim',
    }));
  if (state.kind === 'halted') {
    return [
      ...(safeFile ? [{ text: safeFile, tone: 'textDim' as const }] : []),
      { text: state.word, tone: stateTone(state.tone === 'failed' ? 'failed' : 'attention') },
      ...(safeNote ? [{ text: safeNote, tone: 'textDim' as const }] : []),
    ];
  }
  if (state.method === 'failed')
    return [safeFile].filter(isPresent).map((text) => ({ text, tone: 'textDim' }));
  if (state.method === 'skipped')
    return [
      ...(safeFile ? [{ text: safeFile, tone: 'textDim' as const }] : []),
      { text: 'skipped', tone: stateTone('pending') },
      ...(safeReason ? [{ text: safeReason, tone: 'textDim' as const }] : []),
    ];
  const meta = [getMethodDisplay(state.method, input.t).text];
  if (retries !== undefined && retries > 0) meta.push(countNoun(retries, 'retry', 'retries'));
  if (duration != null) meta.push(formatDuration(duration));
  return [
    ...(safeFile ? [{ text: safeFile, tone: 'textDim' as const }] : []),
    ...meta.map((text, index) => ({
      text,
      tone:
        index === 0
          ? stateTone(
              classifyTaskCompletionMethod(state.method) === 'escalated' ? 'attention' : 'passed',
            )
          : ('textDim' as const),
    })),
  ];
}

function isPresent(part: string | undefined): part is string {
  return part !== undefined && part !== '';
}
