import type { EditorAffinity } from './grapheme-motions.js';

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
