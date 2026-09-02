import { createStore, storeBase } from '../create-store.js';
import {
  applyEditorEvent,
  clampScrollToDocument,
  createEditorState,
  followCaretScroll,
} from '../../core/editor/editor-state.js';
import type {
  EditorEvent,
  EditorLayout,
  EditorState,
  EditorSurface,
} from '../../core/editor/editor-state.js';
import { wrapVisualLines } from '../../core/editor/grapheme-motions.js';

interface OpenParams {
  filePath: string | null;
  value: string;
  ownerToken: number;
  layout: EditorLayout;
}

interface OpenSession {
  status: 'open';
  filePath: string | null;
  ownerToken: number;
  submitting: boolean;
  layout: EditorLayout;
}

export type EditorSessionState = { status: 'closed' } | (OpenSession & EditorState);

// Owner token of a live field-editor session, or null when none is open. The single
// ownership predicate (mount ≡ input-suppression ≡ keys ≡ write-gate) compares
// this against reviewStore.ownerToken.
export function fieldSessionOwnerToken(s: EditorSessionState): number | null {
  return s.status === 'open' && s.surface === 'field' ? s.ownerToken : null;
}

const initial: EditorSessionState = { status: 'closed' };

const store = createStore<EditorSessionState>(initial);

function openSession(surface: EditorSurface, params: OpenParams): EditorSessionState {
  return {
    status: 'open',
    filePath: params.filePath,
    ownerToken: params.ownerToken,
    submitting: false,
    layout: params.layout,
    ...createEditorState(surface, params.value),
  };
}

export const editorStore = {
  ...storeBase(store),
  openRaw: (params: OpenParams) => store.set(openSession('raw', params)),
  openField: (params: OpenParams) => store.set(openSession('field', params)),
  dispatch: (event: EditorEvent) =>
    store.set((s) => {
      if (s.status !== 'open') return s;
      const next = applyEditorEvent(s, event, s.layout);
      if (next === s) return s;
      return { ...s, ...next };
    }),
  setLayout: (layout: EditorLayout) =>
    store.set((s) => {
      if (s.status !== 'open') return s;
      // Idempotent by value: an unchanged layout returns the SAME state so create-store bails on
      // Object.is and never notifies. This lets the field surface re-measure its render box in a
      // layout effect every render without a set → re-render → re-measure loop.
      if (s.layout.columns === layout.columns && s.layout.rows === layout.rows) return s;
      // A resize/reflow re-wraps the document at the new width, which can push the caret's visual
      // row outside the stale scroll window. Re-follow the caret against the NEW layout so it stays
      // visible immediately, without a mis-placed caret persisting until the next keystroke. Wheel
      // scroll-away is unaffected: it flows through scrollBy, not here.
      return { ...s, ...followCaretScroll(s, layout), layout };
    }),
  scrollBy: (delta: number) =>
    store.set((s) => {
      if (s.status !== 'open') return s;
      // Clamp to the same document bounds the viewport paints with (clampScrollToDocument over the
      // wrapped visual-line count): flooring at 0 alone lets wheeling past the last row
      // accumulate phantom offset above maxTop, creating a dead-zone on the way back up.
      const lineCount = wrapVisualLines(s.value, s.layout.columns).length;
      const scrollTop = clampScrollToDocument(s.scrollTop + delta, s.layout.rows, lineCount);
      return scrollTop === s.scrollTop ? s : { ...s, scrollTop };
    }),
  beginSubmit: () => store.set((s) => (s.status !== 'open' ? s : { ...s, submitting: true })),
  close: () => store.set(initial),
};
