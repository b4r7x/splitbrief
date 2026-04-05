import { createStore, storeBase } from './create-store.js';
import type { OverlayType } from '../types.js';

interface OverlayState {
  active: OverlayType;
  exclusive: boolean;
  focus?: string;
}

const store = createStore<OverlayState>({ active: 'none', exclusive: false });

export const overlayStore = {
  ...storeBase(store),
  open: (type: OverlayType, focus?: string) => store.set(s =>
    s.active === type && s.focus === focus && !s.exclusive ? s : { active: type, focus, exclusive: false }
  ),
  close: store.reset,
  setExclusive: (v: boolean) => store.set(s =>
    s.exclusive === v ? s : { ...s, exclusive: v }
  ),
};
