import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { createStore } from './create-store.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';

describe('createStore.use', () => {
  it('supports selectors that return unstable object snapshots without entering a render loop', async () => {
    const store = createStore({ value: 1 });
    let renderCount = 0;
    let ui: ReturnType<typeof renderFeature> | undefined;

    function Harness() {
      renderCount += 1;
      const selected = store.use((state) => ({ value: state.value }));
      return <Text>{selected.value}</Text>;
    }

    try {
      ui = renderFeature(<Harness />);
      await tick();

      expect(ui.lastFrame()).toContain('1');
      expect(renderCount).toBeLessThan(20);

      store.set({ value: 2 });
      await tick();

      expect(ui.lastFrame()).toContain('2');
      expect(renderCount).toBeLessThan(20);
    } finally {
      ui?.unmount();
    }
  });
});
