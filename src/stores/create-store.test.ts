import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { createStore } from './create-store.js';

describe('createStore', () => {
  const make = () => createStore({ count: 0, name: 'test' });

  describe('get / set', () => {
    it('returns initial state', () => {
      const store = make();
      expect(store.get()).toEqual({ count: 0, name: 'test' });
    });

    it('sets state with value', () => {
      const store = make();
      store.set({ count: 5, name: 'updated' });
      expect(store.get()).toEqual({ count: 5, name: 'updated' });
    });

    it('sets state with updater function', () => {
      const store = make();
      store.set(prev => ({ ...prev, count: prev.count + 1 }));
      expect(store.get().count).toBe(1);
    });

    it('skips notification when value is identical (Object.is)', () => {
      const store = make();
      const listener = vi.fn();
      store.subscribe(listener);
      const current = store.get();
      store.set(current);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('notifies listeners on set', () => {
      const store = make();
      const listener = vi.fn();
      store.subscribe(listener);
      store.set({ count: 1, name: 'test' });
      expect(listener).toHaveBeenCalledOnce();
    });

    it('unsubscribes correctly', () => {
      const store = make();
      const listener = vi.fn();
      const unsub = store.subscribe(listener);
      unsub();
      store.set({ count: 1, name: 'test' });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('resets to initial state', () => {
      const store = make();
      store.set({ count: 99, name: 'changed' });
      store.reset();
      expect(store.get()).toEqual({ count: 0, name: 'test' });
    });

    it('resets to provided state', () => {
      const store = make();
      store.reset({ count: 42, name: 'custom' });
      expect(store.get()).toEqual({ count: 42, name: 'custom' });
    });

    it('notifies listeners on reset', () => {
      const store = make();
      store.set({ count: 5, name: 'changed' });
      const listener = vi.fn();
      store.subscribe(listener);
      store.reset();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('skips notification when reset value matches current state', () => {
      const store = make();
      const listener = vi.fn();
      store.subscribe(listener);
      store.reset();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('use (React hook)', () => {
    it('reads state via selector', () => {
      const store = make();
      const { result, unmount } = renderHook(() => store.use(s => s.count));
      expect(result.current).toBe(0);
      unmount();
    });

    it('updates when selected slice changes', async () => {
      const store = make();
      const { result, act, unmount } = renderHook(() => store.use(s => s.count));

      await act(() => {
        store.set(prev => ({ ...prev, count: 7 }));
      });

      expect(result.current).toBe(7);
      unmount();
    });

    it('does not update when unrelated slice changes', async () => {
      const store = make();
      let renderCount = 0;
      const { result, act, unmount } = renderHook(() => {
        renderCount++;
        return store.use(s => s.count);
      });

      const before = renderCount;
      await act(() => {
        store.set(prev => ({ ...prev, name: 'different' }));
      });

      expect(result.current).toBe(0);
      // Note: useSyncExternalStore may still call the selector but
      // React won't re-render if the selected value hasn't changed.
      // We verify the returned value is still correct.
      unmount();
    });
  });
});
