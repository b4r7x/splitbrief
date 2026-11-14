import {
  fitDetailRun,
  FAILED_SUFFIX,
  isPresent,
  TITLE_SEP,
  type DetailSpan,
} from './detail-run.js';
import type { WorkflowTask } from '../../../../core/run-view/briefs.js';
import type { TaskCompletionMethod } from '../../../../core/schemas/enums.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { methodWord } from '../../../../core/sessions/display.js';
import { classifyTaskCompletionMethod } from '../../../../core/task-completion.js';
import { type StateTone, stateTone } from '../../../../core/theme/state-tone.js';
import type { TextTone } from '../../../../core/theme/tone-color.js';
import { sanitizeTerminalDisplayText } from '../../../../utils/display-text/sanitize.js';
import { segmentsForRowText } from '../../../../utils/display-text/width.js';
import { formatDuration } from '../../../../utils/format/time.js';
import { countNoun } from '../../../../utils/pluralize.js';

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
  /** A surface that lists settled briefs under its own headline dims their titles. */
  quiet?: boolean | undefined;
}

export type TaskSummaryProps = TaskSummaryBaseProps &
  (
    | { state: Extract<TaskSummaryState, { kind: 'stage' }>; id?: never; title?: never }
    | { state: Exclude<TaskSummaryState, { kind: 'stage' }>; id: string; title: string }
  );

/**
 * The row after its mark, fitted to `width` (the whole row, mark slot included). The transcript
 * paints these spans, and the closed run's record lists the same ones, so one brief reads one way.
 */
export function taskSummarySpans(
  props: TaskSummaryProps,
): Readonly<{ text: string; tone: TextTone }>[] {
  const { state, width, retries, duration, file, fileNote, extraFiles, reason, note } = props;
  const safeFile = file === undefined ? undefined : sanitizeTerminalDisplayText(file);
  const safeFileNote = fileNote === undefined ? undefined : sanitizeTerminalDisplayText(fileNote);
  const safeExtraFiles =
    extraFiles === undefined ? undefined : sanitizeTerminalDisplayText(extraFiles);
  const safeReason = reason === undefined ? undefined : sanitizeTerminalDisplayText(reason);
  const safeNote = note === undefined ? undefined : sanitizeTerminalDisplayText(note);
  const failed =
    (state.kind === 'settled' && state.method === 'failed') ||
    (state.kind === 'stage' && state.outcome === 'failed');
  const quiet =
    props.quiet === true ||
    state.kind === 'pending' ||
    (state.kind === 'settled' && state.method === 'skipped');
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
    detailRun({ state, safeFile, safeReason, safeNote, retries, duration }),
    width - (failed ? FAILED_SUFFIX.length : 0),
    // A halted brief with a file fits the way a settled one does: its state word and note keep
    // their room, and the path and its count go first.
    state.kind === 'settled' || (state.kind === 'halted' && isPresent(safeFile)),
    isPresent(safeFile) ? safeFileNote : undefined,
    isPresent(safeFile) ? safeExtraFiles : undefined,
  );

  return [
    ...(headingParts === null
      ? [{ text: fitted.head, tone: quiet ? ('textDim' as const) : ('text' as const) }]
      : segmentsForRowText(headingParts, fitted.head)),
    ...(failed ? [{ text: FAILED_SUFFIX, tone: stateTone('failed') }] : []),
    ...fitted.tail.flatMap((part, index) => [
      { text: index === 0 ? TITLE_SEP : SOFT_SEP, tone: 'textDim' as const },
      part,
    ]),
  ];
}

function detailRun(input: {
  state: TaskSummaryState;
  safeFile: string | undefined;
  safeReason: string | undefined;
  safeNote: string | undefined;
  retries: number | undefined;
  duration: number | undefined;
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
  const meta = [methodWord(state.method)];
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
