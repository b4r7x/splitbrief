import { createStore, storeBase } from './create-store.js';
import type { OverlayType } from '../types.js';

interface OverlayState {
  active: OverlayType;
  exclusive: boolean;
  focus?: string | undefined;
  stack: { type: OverlayType; focus?: string | undefined }[];
}

const INITIAL: OverlayState = { active: 'none', exclusive: false, stack: [] };

const store = createStore<OverlayState>(INITIAL);

export const overlayStore = {
  ...storeBase(store),
  open: (type: OverlayType, focus?: string) => store.set(s => {
    if (s.active === type && s.focus === focus && !s.exclusive) return s;
    const stack = s.active !== 'none'
      ? [...s.stack, { type: s.active, focus: s.focus }]
      : s.stack;
    return { active: type, focus, exclusive: false, stack };
  }),
  close: () => store.set(s => {
    const prev = s.stack[s.stack.length - 1];
    if (!prev) return INITIAL;
    return {
      active: prev.type,
      focus: prev.focus,
      exclusive: false,
      stack: s.stack.slice(0, -1),
    };
  }),
  setExclusive: (v: boolean) => store.set(s =>
    s.exclusive === v ? s : { ...s, exclusive: v }
  ),
};
