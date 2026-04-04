import { createStore, storeBase } from './create-store.js';
import type { OverlayType } from '../types.js';

interface OverlayState {
  active: OverlayType;
  exclusive: boolean;
}

const store = createStore<OverlayState>({ active: 'none', exclusive: false });

export const overlayStore = {
  ...storeBase(store),
  open: (type: OverlayType) => store.set(s => ({ ...s, active: type })),
  close: store.reset,
  setExclusive: (v: boolean) => store.set(s => ({ ...s, exclusive: v })),
};
