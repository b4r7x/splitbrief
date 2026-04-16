import { createStore, storeBase } from './create-store.js';

interface Region {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  onClick: () => void;
  seq: number;
}

interface ClickableRegionsState {
  regions: Region[];
  nextSeq: number;
}

const initial: ClickableRegionsState = { regions: [], nextSeq: 0 };
const store = createStore<ClickableRegionsState>(initial);

export const clickableRegionsStore = {
  ...storeBase(store),
  register: (id: string, bounds: { x: number; y: number; width: number; height: number }, onClick: () => void) => {
    store.set(s => {
      const filtered = s.regions.filter(r => r.id !== id);
      return { regions: [...filtered, { id, ...bounds, onClick, seq: s.nextSeq }], nextSeq: s.nextSeq + 1 };
    });
  },
  unregister: (id: string) => {
    store.set(s => ({ ...s, regions: s.regions.filter(r => r.id !== id) }));
  },
  hitTest: (x: number, y: number): boolean => {
    const { regions } = store.get();
    const hits = regions.filter(r =>
      x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
    );
    if (hits.length === 0) return false;
    hits.sort((a, b) => b.seq - a.seq);
    hits[0]?.onClick();
    return true;
  },
};
