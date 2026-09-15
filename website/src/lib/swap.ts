import type { Frame } from './scene.js';

type Swap =
  | { kind: 'idle' }
  | { kind: 'encode'; amount: number; change(): void }
  | { kind: 'decode'; amount: number };

export function createSwap(invalidate: () => void, measure: () => void) {
  let state: Swap = { kind: 'idle' };

  function finish() {
    if (state.kind === 'encode') {
      state.change();
      measure();
    }
    state = { kind: 'idle' };
  }

  return {
    request(change: () => void) {
      state = { kind: 'encode', amount: state.kind === 'idle' ? 1 : state.amount, change };
      invalidate();
    },
    advance(frame: Frame) {
      if (frame.snap) finish();
      else if (state.kind === 'encode') {
        state.amount = Math.max(0, state.amount - frame.deltaMs / 180);
        if (state.amount === 0) {
          state.change();
          measure();
          state = { kind: 'decode', amount: 0 };
        }
      } else if (state.kind === 'decode') {
        state.amount = Math.min(1, state.amount + frame.deltaMs / 300);
        if (state.amount === 1) state = { kind: 'idle' };
      }
      return state.kind !== 'idle';
    },
    amount: () => (state.kind === 'idle' ? 1 : state.amount),
    cancel() {
      state = { kind: 'idle' };
    },
    finish,
  };
}
