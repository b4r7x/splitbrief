import { renderSelection, selectionText, snapshotTerminalFrame } from './frame.js';
import type { SelectionGesture, SelectionState } from './types.js';

export function flushOutput(state: SelectionState, highlight = ''): void {
  const pending = state.pendingOutput;
  state.pendingOutput = [];
  if (pending.length === 0 && highlight.length === 0) return;
  // Ink emits each synchronized-output terminator as a separate write. Defer those
  // complete writes until the highlight is included, even when several frames coalesce.
  const endSynchronizedOutput = Buffer.from('\u001b[?2026l');
  const writes = pending.map((write) => write.data);
  const deferEnd =
    highlight.length > 0 && writes.some((data) => data.equals(endSynchronizedOutput));
  const content = deferEnd ? writes.filter((data) => !data.equals(endSynchronizedOutput)) : writes;
  const data = Buffer.concat([
    ...content,
    Buffer.from(highlight),
    ...(deferEnd ? [endSynchronizedOutput] : []),
  ]);
  state.writeOriginal(data, (error) => {
    for (const write of pending) write.callback?.(error);
  });
}

export function redraw(state: SelectionState): void {
  if (state.disposed || state.suspended) return;
  state.repainting = true;
  try {
    // Ink 6 fullscreen repaints on resize, including unchanged content and OSC 8 links.
    state.stdout.emit('resize');
  } finally {
    state.repainting = false;
  }
}

export function clear(state: SelectionState): void {
  if (!state.gesture) return;
  state.gesture = undefined;
  flushOutput(state);
  redraw(state);
}

export function suspend(state: SelectionState): void {
  state.suspended = true;
  state.gesture = undefined;
  state.writeRevision++;
  state.lifecycleRevision++;
  flushOutput(state);
}

export function resume(state: SelectionState): void {
  if (state.disposed || !state.suspended) return;
  state.suspended = false;
  const revision = ++state.lifecycleRevision;
  state.writeRevision++;
  state.terminal.write('', () => {
    if (state.disposed || state.suspended || revision !== state.lifecycleRevision) return;
    state.terminal.reset();
    state.terminal.resize(state.stdout.columns, state.stdout.rows);
  });
}

export function handleResize(state: SelectionState): void {
  if (state.repainting) return;
  state.gesture = undefined;
  state.writeRevision++;
  flushOutput(state);
  state.terminal.resize(state.stdout.columns, state.stdout.rows);
}

export function reconcile(
  state: SelectionState,
  current: SelectionGesture,
  revision: number,
): void {
  void current.frame.then((original) => {
    if (
      !original ||
      state.disposed ||
      state.suspended ||
      state.gesture !== current ||
      current.phase !== 'selected' ||
      revision !== state.writeRevision
    )
      return;
    const latest = snapshotTerminalFrame(state.terminal);
    if (
      selectionText(latest, current.anchor, current.focus) !==
      selectionText(original, current.anchor, current.focus)
    ) {
      clear(state);
      return;
    }
    // Flush the clean repaint and its highlight together, so clock/stream updates never
    // expose an unhighlighted frame while the asynchronous parser catches up.
    flushOutput(state, renderSelection(latest, current.anchor, current.focus));
  });
}

export function interceptWrite(
  state: SelectionState,
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean {
  const forward = () =>
    typeof encodingOrCallback === 'string'
      ? state.writeOriginal(chunk, encodingOrCallback, callback)
      : state.writeOriginal(chunk, encodingOrCallback ?? callback);
  if (state.suspended || state.disposed) return forward();
  const data =
    typeof chunk === 'string' && typeof encodingOrCallback === 'string'
      ? Buffer.from(chunk, encodingOrCallback)
      : chunk;
  const revision = ++state.writeRevision;
  const lifecycle = state.lifecycleRevision;
  const withheld = state.gesture !== undefined && state.gesture.phase !== 'selected';
  const selected = state.gesture?.phase === 'selected';
  if (selected) {
    state.pendingOutput.push({
      data: Buffer.from(data),
      callback: typeof encodingOrCallback === 'function' ? encodingOrCallback : callback,
    });
  }
  state.terminal.write(data, () => {
    const exited = state.parsedAlternateExit;
    state.parsedAlternateExit = false;
    if (state.disposed || lifecycle !== state.lifecycleRevision) return;
    if (exited) {
      if (withheld) state.writeOriginal('\u001b[?1049l');
      suspend(state);
      return;
    }
    if (state.gesture?.phase === 'selected' && revision === state.writeRevision) {
      reconcile(state, state.gesture, revision);
    }
  });
  if (withheld) {
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (done) queueMicrotask(() => done());
    return true;
  }
  if (selected) return true;
  return forward();
}
