import type { CopyOutcome } from '../../clipboard/copy.js';
import { selectionText } from './frame.js';
import { clear } from './output.js';
import type { SelectionGesture, SelectionState } from './types.js';

export function copySelection(
  state: SelectionState,
  current: SelectionGesture,
): Promise<CopyOutcome | undefined> {
  const focus = current.focus;
  const result = state.copyQueue
    .then(async () => {
      const frame = await current.frame;
      if (!frame || state.disposed) return;
      const text = selectionText(frame, current.anchor, focus);
      if (!text) return;
      return state.copy(text);
    })
    .catch(() => 'unavailable' as const);
  state.copyQueue = result.then(() => {});
  return result;
}

export function reportCopyError(state: SelectionState, result: CopyOutcome | undefined): void {
  if (result === 'unavailable' && !state.disposed)
    state.reportError('Could not copy selected text.');
}

function reportCopyKey(state: SelectionState, result: Promise<CopyOutcome | undefined>): void {
  if (state.onCopyKey) state.onCopyKey(result);
  else void result.then((outcome) => reportCopyError(state, outcome));
}

export function filterInput(state: SelectionState, text: string): string {
  if (!state.gesture || text.length === 0) return text;
  if (text.startsWith('\u0003') && state.gesture.phase !== 'pressed') {
    const result = copySelection(state, state.gesture);
    clear(state);
    reportCopyKey(state, result);
    return text.slice(1);
  }
  // The stdin boundary supplies complete CSI-u keys, never partial escape prefixes.
  const encoded = text.startsWith('\u001b[')
    ? /^(\d+)(?::[\d:]*)?(?:;(\d+)(?::([123]))?)?(?:;[\d:]*)?u$/.exec(text.slice(2))
    : null;
  if (encoded?.[3] === '3') return text;
  const modifiers = Number(encoded?.[2] ?? '1') - 1;
  const shortcutModifiers = modifiers & ~(64 | 128);
  const copyKey = encoded?.[1] === '99' && (shortcutModifiers === 4 || shortcutModifiers === 8);
  if (copyKey && state.gesture.phase !== 'pressed') {
    const result = copySelection(state, state.gesture);
    if (shortcutModifiers === 4) clear(state);
    reportCopyKey(state, result);
    return '';
  }
  clear(state);
  return text === '\u001b' || (encoded?.[1] === '27' && modifiers === 0) ? '' : text;
}
