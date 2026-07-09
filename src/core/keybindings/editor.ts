import type { NormalizedKeySignature } from './normalize.js';
import type { EditorEvent, EditorMotion } from '../editor/editor-state.js';

export type EditorKeyAction =
  | EditorEvent
  | { kind: 'save' }
  | { kind: 'cancel' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'open-external' }
  | null;

export function resolveEditorKeyAction(sig: NormalizedKeySignature): EditorKeyAction {
  const motion = (target: EditorMotion): EditorEvent => ({
    kind: 'motion',
    motion: target,
    select: sig.shift,
  });

  if (sig.key === 'escape') return { kind: 'cancel' };
  if (sig.key === 'enter' || sig.input === '\n' || sig.input === '\r') {
    return { kind: 'insert', text: '\n' };
  }
  if (sig.key === 'tab') return null;

  if (sig.key === 'arrow-left') return motion(sig.ctrl || sig.alt ? 'word-left' : 'char-left');
  if (sig.key === 'arrow-right') return motion(sig.ctrl || sig.alt ? 'word-right' : 'char-right');
  if (sig.key === 'arrow-up') return motion('up');
  if (sig.key === 'arrow-down') return motion('down');
  if (sig.key === 'page-up') return motion('page-up');
  if (sig.key === 'page-down') return motion('page-down');
  if (sig.key === 'home') return motion(sig.ctrl ? 'doc-start' : 'line-start');
  if (sig.key === 'end') return motion(sig.ctrl ? 'doc-end' : 'line-end');

  if (sig.key === 'backspace') {
    return { kind: 'delete', dir: 'backward', unit: sig.ctrl || sig.alt ? 'word' : 'char' };
  }
  if (sig.key === 'delete') {
    return { kind: 'delete', dir: 'forward', unit: sig.ctrl || sig.alt ? 'word' : 'char' };
  }

  if (sig.ctrl && sig.key === 's') return { kind: 'save' };
  if (sig.ctrl && sig.key === 'j') return { kind: 'insert', text: '\n' };
  if (sig.ctrl && sig.key === 'o') return { kind: 'open-external' };
  if (sig.ctrl && sig.shift && sig.key === 'z') return { kind: 'redo' };
  if (sig.ctrl && sig.key === 'z') return { kind: 'undo' };
  if (sig.ctrl && sig.key === 'y') return { kind: 'copy' };
  if (sig.alt && sig.key === 'c') return { kind: 'copy' };
  if (sig.ctrl && sig.key === 'x') return { kind: 'cut' };
  if (sig.alt && sig.key === 'x') return { kind: 'cut' };
  if (sig.alt && sig.key === 'a') return { kind: 'select-all' };

  if (!sig.ctrl && !sig.alt && !sig.super && sig.input.length > 0) {
    const code = sig.input.charCodeAt(0);
    if (code >= 0x20 && sig.input !== '\x7f') return { kind: 'insert', text: sig.input };
  }
  return null;
}
