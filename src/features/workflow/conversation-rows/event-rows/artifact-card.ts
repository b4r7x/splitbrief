import { configStore } from '../../../../stores/project/config.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { filePathUrl, projectRelativePathLabel } from '../../../../utils/path-links.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import { wrapWidthFor } from '../row-markers.js';
import { segmentedRow } from '../row-format/rows.js';
import { sourceFooterSegments } from '../row-format/preformatted-block.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowSegment } from '../types.js';

const BODY_PREFIX = '  ';
const LABEL_GAP = '  ';
const SEPARATOR = '/';
const ELISION = '…';
const FILE_EXTENSION = /\.[^./\\]+$/;

export function artifactWrittenRowBlock(
  keyPrefix: string,
  event: EngineEventOf<'artifact_written'>,
  width: number,
): ConversationRowBlock | null {
  if (event.excerpt.length === 0) return null;

  const bodyWidth = Math.max(1, wrapWidthFor('card-body', width) - BODY_PREFIX.length);
  const rows: ConversationRow[] = [
    segmentedRow(
      `${keyPrefix}-top`,
      [
        { text: artifactLabel(event.filename), tone: 'planner', bold: true },
        { text: LABEL_GAP },
        { text: countNoun(event.lineCount, 'line'), tone: 'textDim' },
      ],
      'card-top',
    ),
    // The excerpt is lifted out of a larger document — an outline of its headings, or a slice of
    // its opening — so it renders as plain text: either shape can open a fence or a list it never
    // closes, and markdown would style the wreckage as if it meant it. Cut at the right edge for
    // the same reason: a wrapped heading would read as two.
    ...event.excerpt.map((line, index) =>
      segmentedRow(
        `${keyPrefix}-line-${index}`,
        [
          { text: BODY_PREFIX },
          { text: truncateTerminalDisplayText(line, bodyWidth), tone: 'textDim' },
        ],
        'card-body',
      ),
    ),
  ];

  const footer = sourceFooterSegments({
    // The unit comes from whoever built the excerpt: an outline of a spec leaves out sections and a
    // brief list leaves out tasks, and calling either "lines" invited an arithmetic that was never
    // true — the rows above are synthesized, not lines lifted off the document.
    hidden: event.omittedCount,
    unit: event.omittedUnit,
    pointer: sourcePointer(event),
    fitPointer: elidedPathLabel,
    width: bodyWidth,
  });
  if (footer !== null) {
    rows.push(
      segmentedRow(`${keyPrefix}-pad`, [{ text: '' }], 'card-body'),
      segmentedRow(`${keyPrefix}-source`, [{ text: BODY_PREFIX }, ...footer], 'card-body'),
    );
  }

  return {
    key: keyPrefix,
    rowCount: rows.length,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      rows.slice(Math.max(0, windowStart), Math.max(0, windowEnd)),
  };
}

// `wrote` on every one of these cards would make the label column unreadable, so the label is the
// artifact itself — Spec, Plan, Tasks, Research — in the same words and tone the planner headers
// already use.
function artifactLabel(filename: string): string {
  const stem = filename.replace(FILE_EXTENSION, '');
  return stem.length === 0 ? filename : `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
}

// The last row of the card is where the document lives, so the count of unshown lines and the path
// that holds them sit on the same row: a reader who reaches the cut has the way out under the
// cursor rather than a header that scrolled away ten lines ago.
function sourcePointer(event: EngineEventOf<'artifact_written'>): ConversationRowSegment {
  const rootDir = configStore.get().projectDir;
  if (rootDir === '') return { text: event.filename, tone: 'reviewFile' };
  return {
    text: projectRelativePathLabel({ path: event.path, rootDir }),
    tone: 'reviewFile',
    href: filePathUrl({ path: event.path, rootDir }),
  };
}

// A path is elided by dropping whole directories, never by cutting mid-name, and always down to
// the same two: the root it lives under and the file itself. Cutting by width instead put the four
// artifacts of one session at four different columns — one directory, four boundaries, nothing
// lining up when they stack in the transcript.
function elidedPathLabel(path: string, width: number): string {
  if (getTerminalCellWidth(path) <= width) return path;

  const segments = path.split(SEPARATOR);
  const head = segments[0] ?? '';
  const file = segments.at(-1) ?? '';
  if (segments.length < 3) return truncateTerminalDisplayTextMiddle(path, width);

  const elided = `${head}${SEPARATOR}${ELISION}${SEPARATOR}${file}`;
  return getTerminalCellWidth(elided) <= width
    ? elided
    : truncateTerminalDisplayTextMiddle(elided, width);
}
