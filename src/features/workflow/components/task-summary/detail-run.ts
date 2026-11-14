import { ROW_LEADING } from '../../../../components/row-leading.js';
import { formatTaskHeading } from '../../../../core/run-view/brief-labels.js';
import type { WorkflowTask } from '../../../../core/run-view/briefs.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import type { StateTone } from '../../../../core/theme/state-tone.js';
import { glyph } from '../../../../lib/glyphs.js';
import {
  truncateTerminalDisplayTextMiddle,
  truncateTerminalDisplayText,
  elidePathMiddle,
} from '../../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';

// The transcript's leading: the shared one-cell pad the hover bar paints into, then the marker and
// its trailing space. A brief's mark lands on column 1 with its title on column 3, the same shape a
// live row's header wears; the budget pays for every cell, measured off the leading itself.
export function leadingWith(mark: string): string {
  return `${ROW_LEADING}${mark} `;
}
const LEADING_CELLS = getTerminalCellWidth(leadingWith(glyph('stageDone')));
// Two spaces divide the title from the detail run, `·` divides the run's own parts — the same two
// levels a running task header uses, so a settled row and a live row read the same way.
export const TITLE_SEP = '  ';
export const FAILED_SUFFIX = ' failed';

interface FittedDetailRun {
  head: string;
  tail: DetailSpan[];
}

export interface DetailSpan {
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
      // A path cut inside its file name names no file, so the path and its count drop together.
      const shortenedFile = elidePathMiddle(file.text, room);
      if (shortenedFile.endsWith(file.text.slice(file.text.lastIndexOf('/') + 1)))
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

export function isPresent(part: string | undefined): part is string {
  return part !== undefined && part !== '';
}
