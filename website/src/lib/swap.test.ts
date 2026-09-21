import { describe, expect, it } from 'vitest';
import { createSwap } from './swap.js';

describe('tab transitions', () => {
  it('encodes before changing content, then finishes decoding at every refresh rate', () => {
    for (const hz of [60, 120, 144]) {
      let content = 'old';
      const swap = createSwap(
        () => {},
        () => {},
      );
      swap.request(() => {
        content = 'new';
      });
      for (let elapsed = 0; elapsed < 600; elapsed += 1000 / hz) {
        const before = swap.amount();
        swap.advance({ deltaMs: 1000 / hz, snap: false });
        if (content === 'old') expect(swap.amount()).toBeLessThanOrEqual(before);
        if (elapsed < 150) expect(content).toBe('old');
      }
      expect(content).toBe('new');
      expect(swap.amount()).toBe(1);
    }
  });

  it('only applies the latest selection and completes immediately for reduced motion', () => {
    const applied: string[] = [];
    const swap = createSwap(
      () => {},
      () => {},
    );
    swap.request(() => applied.push('first'));
    swap.advance({ deltaMs: 100, snap: false });
    swap.request(() => applied.push('latest'));
    swap.advance({ deltaMs: 0, snap: true });
    expect(applied).toEqual(['latest']);
    expect(swap.amount()).toBe(1);
  });

  it('cancels an outgoing page without applying it later', () => {
    let applied = false;
    const swap = createSwap(
      () => {},
      () => {},
    );
    swap.request(() => {
      applied = true;
    });
    swap.advance({ deltaMs: 100, snap: false });
    swap.cancel();
    swap.advance({ deltaMs: 500, snap: false });
    expect(applied).toBe(false);
    expect(swap.amount()).toBe(1);
  });
});
