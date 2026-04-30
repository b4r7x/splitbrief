import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { createStore } from './create-store.js';
import { useStores } from './use-stores.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';

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

  it('keeps the same subscriptions across unrelated rerenders when store identities do not change', async () => {
    const base = createStore({ count: 0 });
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const store = {
      get: base.get,
      subscribe: (listener: () => void) => {
        subscribeCount += 1;
        const unsubscribe = base.subscribe(listener);
        return () => {
          unsubscribeCount += 1;
          unsubscribe();
        };
      },
    };

    function Harness({ label }: { label: string }) {
      const [state] = useStores(store);
      return <Text>{label}:{state.count}</Text>;
    }

    const ui = renderFeature(<Harness label="first" />);
    await tick();

    ui.rerender(<Harness label="second" />);
    await tick();

    expect(ui.lastFrame()).toContain('second:0');
    expect(subscribeCount).toBe(1);
    expect(unsubscribeCount).toBe(0);

    ui.unmount();

    expect(unsubscribeCount).toBe(1);
  });
});
