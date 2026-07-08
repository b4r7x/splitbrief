import {
  prevGraphemeIndex,
  nextGraphemeIndex,
  wrapVisualLines,
  indexAtDisplayColumn,
  wordBoundaryBackward,
  wordBoundaryForward,
  visualPositionOf,
  isSoftWrapSeam,
} from './grapheme-motions.js';
import type { EditorAffinity, VisualLine } from './grapheme-motions.js';
import { assertNever } from '../../utils/type-guards.js';

export type EditorSurface = 'raw' | 'field';

export type EditClass = 'insert' | 'delete' | 'newline' | 'paste' | 'motion';

export type EditorMotion =
  | 'char-left'
  | 'char-right'
  | 'word-left'
  | 'word-right'
  | 'line-start'
  | 'line-end'
  | 'up'
  | 'down'
  | 'doc-start'
  | 'doc-end'
  | 'page-up'
  | 'page-down';

export interface EditorSnapshot {
  value: string;
  cursor: number;
  anchor: number | null;
}

export interface EditorState {
  surface: EditorSurface;
  value: string;
  cursor: number;
  goalCol: number | null;
  anchor: number | null;
  undo: EditorSnapshot[];
  redo: EditorSnapshot[];
  lastEditClass: EditClass | null;
  scrollTop: number;
  affinity: EditorAffinity;
}

export type EditorEvent =
  | { kind: 'insert'; text: string; paste?: boolean }
  | { kind: 'delete'; dir: 'backward' | 'forward'; unit: 'char' | 'word' | 'line' }
  | { kind: 'motion'; motion: EditorMotion; select: boolean }
  | { kind: 'select-all' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'set-cursor'; index: number; select?: boolean };

export interface EditorLayout {
  columns: number;
  rows: number;
}

export const UNDO_RING_CAP = 200;

export function createEditorState(surface: EditorSurface, value: string): EditorState {
  return {
    surface,
    value,
    cursor: 0,
    goalCol: null,
    anchor: null,
    undo: [],
    redo: [],
    lastEditClass: null,
    scrollTop: 0,
    affinity: 'upstream',
  };
}

export function selectionRange(state: EditorState): { start: number; end: number } | null {
  if (state.anchor === null || state.anchor === state.cursor) return null;
  return state.anchor < state.cursor
    ? { start: state.anchor, end: state.cursor }
    : { start: state.cursor, end: state.anchor };
}

function snapshotOf(state: EditorState): EditorSnapshot {
  return { value: state.value, cursor: state.cursor, anchor: state.anchor };
}

function pushUndo(state: EditorState, cls: EditClass): EditorSnapshot[] {
  if (cls === 'insert' && state.lastEditClass === 'insert') return state.undo;
  const next = [...state.undo, snapshotOf(state)];
  if (next.length > UNDO_RING_CAP) next.splice(0, next.length - UNDO_RING_CAP);
  return next;
}

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

function deleteRange(
  value: string,
  cursor: number,
  dir: 'backward' | 'forward',
  unit: 'char' | 'word' | 'line',
  layout: EditorLayout,
): { start: number; end: number } {
  if (dir === 'backward') {
    if (unit === 'char') return { start: prevGraphemeIndex(value, cursor), end: cursor };
    if (unit === 'word') return { start: wordBoundaryBackward(value, cursor), end: cursor };
    const lines = wrapVisualLines(value, layout.columns);
    const { row } = visualPositionOf(lines, cursor);
    return { start: lines[row]?.start ?? 0, end: cursor };
  }
  if (unit === 'char') return { start: cursor, end: nextGraphemeIndex(value, cursor) };
  if (unit === 'word') return { start: cursor, end: wordBoundaryForward(value, cursor) };
  const lines = wrapVisualLines(value, layout.columns);
  const { row } = visualPositionOf(lines, cursor);
  return { start: cursor, end: lines[row]?.end ?? value.length };
}

function applyInsert(
  state: EditorState,
  event: { kind: 'insert'; text: string; paste?: boolean },
): EditorState {
  const sel = selectionRange(state);
  if (event.text === '' && sel === null) return state;
  const start = sel ? sel.start : state.cursor;
  const end = sel ? sel.end : state.cursor;
  const cls: EditClass = event.paste ? 'paste' : event.text === '\n' ? 'newline' : 'insert';
  const merged = state.value.slice(0, start) + event.text + state.value.slice(end);
  const cursorBefore = start + event.text.length;
  const nfc = merged.normalize('NFC');
  const cursor =
    merged === nfc ? cursorBefore : merged.slice(0, cursorBefore).normalize('NFC').length;
  return {
    ...state,
    value: nfc,
    cursor,
    anchor: null,
    goalCol: null,
    undo: pushUndo(state, cls),
    redo: [],
    lastEditClass: cls,
    affinity: 'upstream',
  };
}

function applyDelete(
  state: EditorState,
  event: { kind: 'delete'; dir: 'backward' | 'forward'; unit: 'char' | 'word' | 'line' },
  layout: EditorLayout,
): EditorState {
  const sel = selectionRange(state);
  const range = sel ?? deleteRange(state.value, state.cursor, event.dir, event.unit, layout);
  if (range.start === range.end) return state;
  return {
    ...state,
    value: state.value.slice(0, range.start) + state.value.slice(range.end),
    cursor: range.start,
    anchor: null,
    goalCol: null,
    undo: pushUndo(state, 'delete'),
    redo: [],
    lastEditClass: 'delete',
    affinity: 'upstream',
  };
}

function applyMotion(
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

export function clampScrollTop(caretRow: number, height: number, scrollTop: number): number {
  if (height <= 0) return 0;
  if (caretRow < scrollTop) return Math.max(0, caretRow);
  if (caretRow >= scrollTop + height) return caretRow - height + 1;
  return scrollTop;
}

export function clampScrollToDocument(
  scrollTop: number,
  height: number,
  lineCount: number,
): number {
  const maxTop = Math.max(0, lineCount - height);
  return Math.max(0, Math.min(scrollTop, maxTop));
}

export function followCaretScroll(state: EditorState, layout: EditorLayout): EditorState {
  const lines = wrapVisualLines(state.value, layout.columns);
  const { row } = visualPositionOf(lines, state.cursor, state.affinity);
  const scrollTop = clampScrollTop(row, layout.rows, state.scrollTop);
  return scrollTop === state.scrollTop ? state : { ...state, scrollTop };
}

export function applyEditorEvent(
  state: EditorState,
  event: EditorEvent,
  layout: EditorLayout,
): EditorState {
  const next = reduceEditorEvent(state, event, layout);
  return next === state ? state : followCaretScroll(next, layout);
}

function reduceEditorEvent(
  state: EditorState,
  event: EditorEvent,
  layout: EditorLayout,
): EditorState {
  switch (event.kind) {
    case 'insert':
      return applyInsert(state, event);
    case 'delete':
      return applyDelete(state, event, layout);
    case 'motion':
      return applyMotion(state, event, layout);
    case 'select-all':
      return {
        ...state,
        anchor: 0,
        cursor: state.value.length,
        goalCol: null,
        affinity: 'upstream',
        lastEditClass: 'motion',
      };
    case 'undo': {
      const snapshot = state.undo[state.undo.length - 1];
      if (!snapshot) return state;
      return {
        ...state,
        value: snapshot.value,
        cursor: snapshot.cursor,
        anchor: snapshot.anchor,
        goalCol: null,
        affinity: 'upstream',
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, snapshotOf(state)],
        lastEditClass: null,
      };
    }
    case 'redo': {
      const snapshot = state.redo[state.redo.length - 1];
      if (!snapshot) return state;
      return {
        ...state,
        value: snapshot.value,
        cursor: snapshot.cursor,
        anchor: snapshot.anchor,
        goalCol: null,
        affinity: 'upstream',
        undo: [...state.undo, snapshotOf(state)],
        redo: state.redo.slice(0, -1),
        lastEditClass: null,
      };
    }
    case 'set-cursor': {
      const index = Math.max(0, Math.min(event.index, state.value.length));
      const anchor = event.select ? (state.anchor === null ? state.cursor : state.anchor) : null;
      return {
        ...state,
        cursor: index,
        anchor,
        goalCol: null,
        affinity: 'upstream',
        lastEditClass: 'motion',
      };
    }
    default:
      return assertNever(event);
  }
}
