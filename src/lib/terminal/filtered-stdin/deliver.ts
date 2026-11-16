import type { FilterState, InputEntry, MouseAction } from './types.js';

export function emitText(filtered: NodeJS.ReadStream, text: string): void {
  if (text.length === 0) return;
  filtered.write(text, 'utf8');
  // Ink consumes stdin through its `readable` listener. Flush each wire
  // segment before a following paste event can be emitted; otherwise Node's
  // readable buffer joins bytes on both sides of a paste and loses their
  // insertion order at the editor boundary.
  filtered.emit('readable');
}

// A wheel step whose actions all say that they only wrote a store lets the wheel step behind it run
// in the same turn, so a row of such steps takes one turn and one render.
function deliverWheelRow(state: FilterState, first: MouseAction[]): void {
  let actions = first;
  while (actions.map((action) => action()).every((joins) => joins === true)) {
    const next = state.queue[0];
    if (next?.kind !== 'wheel') return;
    state.queue.shift();
    actions = next.actions;
  }
}

function deliverEntry(state: FilterState, entry: InputEntry): void {
  switch (entry.kind) {
    case 'key':
      emitText(state.filtered, entry.text);
      return;
    case 'paste':
      state.options?.onPaste?.();
      // A focused text field consumes the paste before Ink can interpret a lone
      // newline or tab as a key. Other views retain their plain-text fallback.
      if (!state.filtered.emit('paste', entry.text)) emitText(state.filtered, entry.text);
      return;
    case 'mouse':
      for (const action of entry.actions) action();
      return;
    case 'wheel':
      deliverWheelRow(state, entry.actions);
      return;
  }
}

// Ink runs each key of one read against the handlers of the last render. With a hold, Ink gets one
// key, paste or mouse action, or one row of wheel steps, at a time: the next one waits until the
// app has taken it.
export function drain(state: FilterState): void {
  while (!state.waiting) {
    const entry = state.queue.shift();
    if (entry === undefined) return;
    state.delivering = true;
    deliverEntry(state, entry);
    state.delivering = false;
    if (state.hold !== null) {
      state.waiting = true;
      state.hold(() => {
        state.waiting = false;
        drain(state);
      });
    }
  }
}
