import type { MouseEvent, MouseListener } from '../filtered-stdin/types.js';
import { renderSelection, snapshotTerminalFrame, type TerminalFrame } from './frame.js';
import { copySelection, reportCopyError } from './copy.js';
import { clear, reconcile, redraw } from './output.js';
import type { SelectionGesture, SelectionState } from './types.js';

function paint(state: SelectionState, current: SelectionGesture): void {
  void current.frame.then((frame) => {
    if (
      !frame ||
      state.disposed ||
      state.suspended ||
      state.gesture !== current ||
      current.phase !== 'dragging'
    )
      return;
    const previous = current.painted;
    if (previous?.focus.x === current.focus.x && previous.focus.y === current.focus.y) return;
    state.writeOriginal(renderSelection(frame, current.anchor, current.focus, previous));
    current.painted = { anchor: current.anchor, focus: current.focus };
  });
}

export function handleMouse(
  state: SelectionState,
  event: MouseEvent,
  dispatch: MouseListener,
): void {
  if (state.disposed || state.suspended) {
    dispatch(event);
    return;
  }
  if (event.type === 'wheel-up' || event.type === 'wheel-down') {
    clear(state);
    dispatch(event);
    return;
  }
  const point = {
    x: Math.max(0, Math.min(state.stdout.columns - 1, event.x - 1)),
    y: Math.max(0, Math.min(state.stdout.rows - 1, event.y - 1)),
  };
  if (event.type === 'press') {
    clear(state);
    if (event.button !== 0 || event.ctrl || event.meta || event.shift) {
      dispatch(event);
      return;
    }
    const frame = new Promise<TerminalFrame | undefined>((resolve) => {
      state.terminal.write('', () =>
        resolve(state.disposed ? undefined : snapshotTerminalFrame(state.terminal)),
      );
    });
    state.gesture = { phase: 'pressed', anchor: point, focus: point, frame };
    return;
  }
  const current = state.gesture;
  if (!current || current.phase === 'selected') {
    dispatch(event);
    return;
  }
  if (event.type === 'move' && event.button !== 0) {
    clear(state);
    dispatch(event);
    return;
  }
  current.focus = point;
  if (point.x !== current.anchor.x || point.y !== current.anchor.y) current.phase = 'dragging';
  if (event.type === 'move') {
    paint(state, current);
    return;
  }
  if (event.type === 'release') {
    if (current.phase === 'dragging') {
      current.phase = 'selected';
      void copySelection(state, current).then((result) => reportCopyError(state, result));
      redraw(state);
      const revision = state.writeRevision;
      state.terminal.write('', () => reconcile(state, current, revision));
    } else {
      clear(state);
      dispatch({ ...event, type: 'press' });
    }
  }
}
