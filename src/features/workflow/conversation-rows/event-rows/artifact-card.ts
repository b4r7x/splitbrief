import { configStore } from '../../../../stores/project/config.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { filePathUrl, projectRelativePathLabel } from '../../../../utils/path/links.js';
import {
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { wrapWidthFor } from '../row-format/markers.js';
import { segmentedRow } from '../row-format/rows.js';
import { rowsBlock } from '../blocks/compose.js';
import { LABEL_CELLS } from '../row-format/tree.js';
import type { ConversationRowBlock, ConversationRowSegment } from '../types.js';

const SEPARATOR = '/';
const ELISION = '…';
const FILE_EXTENSION = /\.[^./\\]+$/;

export function artifactWrittenRowBlock(
  keyPrefix: string,
  event: EngineEventOf<'artifact_written'>,
  width: number,
): ConversationRowBlock | null {
  const budget = wrapWidthFor('message', width);
  const labelWidth = Math.min(LABEL_CELLS, Math.max(1, budget - 1));
  const label = truncateTerminalDisplayText(artifactLabel(event.filename), labelWidth - 1);
  const pointer = sourcePointer(event);
  return rowsBlock(keyPrefix, [
    segmentedRow(
      keyPrefix,
      [
        { text: label, tone: 'planner', bold: true },
        { text: ' '.repeat(labelWidth - getTerminalCellWidth(label)), tone: 'textDim' },
        { ...pointer, text: elidedPathLabel(pointer.text, budget - labelWidth) },
      ],
      'message',
    ),
  ]);
}

function artifactLabel(filename: string): string {
  const stem = filename.replace(FILE_EXTENSION, '');
  return stem.length === 0 ? filename : `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
}

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
