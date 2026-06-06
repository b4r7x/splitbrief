import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { createStore } from './create-store.js';
import { useStores } from './use-stores.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';

describe('useStores', () => {
  it('lets callbacks captured from an earlier render read the latest store state', async () => {
    const store = createStore({ count: 0 });
    let readCapturedCount: (() => number) | undefined;

    function Harness() {
      const [state] = useStores(store);
      readCapturedCount ??= () => state.count;
      return <Text>{state.count}</Text>;
    }

    const ui = renderFeature(<Harness />);
    await tick();

    expect(readCapturedCount?.()).toBe(0);

    store.set({ count: 1 });
    await tick();

    expect(ui.lastFrame()).toContain('1');
    expect(readCapturedCount?.()).toBe(1);

    ui.unmount();
  });
});
