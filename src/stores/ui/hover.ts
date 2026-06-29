import { createStore, storeBase } from '../create-store.js';

export type HoverSurface = 'brief' | 'conversation';

export interface Hover {
  surface: HoverSurface;
  index: number;
}

const store = createStore<Hover | null>(null);

export const hoverStore = {
  ...storeBase(store),
  set: (surface: HoverSurface, index: number) =>
    store.set((s) => (s?.surface === surface && s.index === index ? s : { surface, index })),
  clear: () => store.set((s) => (s === null ? s : null)),
};
