import {
  type VisualLine,
  prevGraphemeIndex,
  nextGraphemeIndex,
  wordBoundaryBackward,
  wordBoundaryForward,
  type EditorAffinity,
  indexAtDisplayColumn,
  isSoftWrapSeam,
  visualPositionOf,
  wrapVisualLines,
} from './grapheme-motions.js';
import type { EditorLayout, EditorMotion, EditorState } from './types.js';

function horizontalTarget(
  value: string,
  cursor: number,
  motion: EditorMotion,
  lines: VisualLine[],
  row: number,
): number {
  switch (motion) {
    case 'char-left':
      return prevGraphemeIndex(value, cursor);
    case 'char-right':
      return nextGraphemeIndex(value, cursor);
    case 'word-left':
      return wordBoundaryBackward(value, cursor);
    case 'word-right':
      return wordBoundaryForward(value, cursor);
    case 'line-start':
      return lines[row]?.start ?? 0;
    case 'line-end':
      return lines[row]?.end ?? value.length;
    case 'doc-start':
      return 0;
    case 'doc-end':
      return value.length;
    default:
      return cursor;
  }
}

export function applyMotion(
  state: EditorState,
  event: { kind: 'motion'; motion: EditorMotion; select: boolean },
  layout: EditorLayout,
): EditorState {
  const lines = wrapVisualLines(state.value, layout.columns);
  const { row, col } = visualPositionOf(lines, state.cursor, state.affinity);
  const vertical =
    event.motion === 'up' ||
    event.motion === 'down' ||
    event.motion === 'page-up' ||
    event.motion === 'page-down';

  let cursor = state.cursor;
  let goalCol: number | null = null;
  let affinity: EditorAffinity = 'upstream';

  if (vertical) {
    const goal = state.goalCol ?? col;
    goalCol = goal;
    const page = Math.max(1, layout.rows - 1);
    const step =
      event.motion === 'up'
        ? -1
        : event.motion === 'down'
          ? 1
          : event.motion === 'page-up'
            ? -page
            : page;
    const isPage = event.motion === 'page-up' || event.motion === 'page-down';
    let targetRow = row + step;
    if (isPage) targetRow = Math.max(0, Math.min(lines.length - 1, targetRow));
    if (targetRow >= 0 && targetRow <= lines.length - 1) {
      const line = lines[targetRow];
      cursor = line ? line.start + indexAtDisplayColumn(line.text, goal) : state.cursor;
      // Paint the caret on the row the motion landed on. When the landed index is a soft-wrap
      // seam AND is the target row's start, only 'downstream' attributes it to targetRow; every
      // other landing (row end, non-seam) paints correctly under 'upstream'. Choosing by motion
      // direction alone skipped the target row on the mirror sub-cases (Down→row.end, Up→row.start).
      if (line && cursor === line.start && isSoftWrapSeam(lines, cursor)) {
        affinity = 'downstream';
      }
    }
  } else {
    cursor = horizontalTarget(state.value, state.cursor, event.motion, lines, row);
  }

  const anchor = event.select ? (state.anchor === null ? state.cursor : state.anchor) : null;
  return { ...state, cursor, anchor, goalCol, affinity, lastEditClass: 'motion' };
}
