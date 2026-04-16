import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { describe, it, expect } from 'vitest';
import { createStore } from './create-store.js';
import { useStores } from './use-stores.js';

interface HarnessResult<T> {
  renders: T[];
  unmount: () => void;
}

function mount<T>(read: () => T): HarnessResult<T> {
  const renders: T[] = [];

  function Probe() {
    renders.push(read());
    return null;
  }

  const instance = render(React.createElement(Probe), {
    stdout: new PassThrough() as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });

  return { renders, unmount: () => instance.unmount() };
}

async function flush() {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('useStores', () => {
  it('single store: destructure returns current values', async () => {
    const store = createStore({ phase: 'idle', count: 0 });
    const h = mount(() => {
      const [s] = useStores(store);
      return { phase: s.phase, count: s.count };
    });
    await flush();
    expect(h.renders.at(-1)).toEqual({ phase: 'idle', count: 0 });
    h.unmount();
  });

  it('multi store: tuple preserves argument order with independent state', async () => {
    const a = createStore({ value: 'A' });
    const b = createStore({ value: 'B' });
    const c = createStore({ value: 'C' });
    const h = mount(() => {
      const [ra, rb, rc] = useStores(a, b, c);
      return { a: ra.value, b: rb.value, c: rc.value };
    });
    await flush();
    expect(h.renders.at(-1)).toEqual({ a: 'A', b: 'B', c: 'C' });
    h.unmount();
  });

  it('re-renders when an accessed key changes', async () => {
    const store = createStore({ tracked: 0, untracked: 0 });
    const h = mount(() => {
      const [s] = useStores(store);
      return s.tracked;
    });
    await flush();
    const before = h.renders.length;
    store.set(prev => ({ ...prev, tracked: 1 }));
    await flush();
    expect(h.renders.length).toBeGreaterThan(before);
    expect(h.renders.at(-1)).toBe(1);
    h.unmount();
  });

  it('does NOT re-render when an unread key changes', async () => {
    const store = createStore({ tracked: 0, untracked: 0 });
    const h = mount(() => {
      const [s] = useStores(store);
      return s.tracked;
    });
    await flush();
    const before = h.renders.length;
    store.set(prev => ({ ...prev, untracked: 99 }));
    await flush();
    expect(h.renders.length).toBe(before);
    h.unmount();
  });

  it('no collision between stores with same key name', async () => {
    const left = createStore({ value: 'L' });
    const right = createStore({ value: 'R' });
    const h = mount(() => {
      const [l, r] = useStores(left, right);
      return { l: l.value, r: r.value };
    });
    await flush();
    const before = h.renders.length;
    right.set({ value: 'R2' });
    await flush();
    expect(h.renders.at(-1)).toEqual({ l: 'L', r: 'R2' });
    expect(h.renders.length).toBeGreaterThan(before);
    h.unmount();
  });

  it('conditional reads adapt across renders (per-render accessed reset)', async () => {
    const store = createStore<{ mode: 'a' | 'b'; a: number; b: number }>({ mode: 'a', a: 0, b: 0 });
    const h = mount(() => {
      const [s] = useStores(store);
      return s.mode === 'a' ? s.a : s.b;
    });
    await flush();
    const initial = h.renders.length;

    store.set(prev => ({ ...prev, b: 7 }));
    await flush();
    expect(h.renders.length).toBe(initial);

    store.set(prev => ({ ...prev, mode: 'b' }));
    await flush();
    expect(h.renders.at(-1)).toBe(7);

    const afterSwitch = h.renders.length;
    store.set(prev => ({ ...prev, a: 42 }));
    await flush();
    expect(h.renders.length).toBe(afterSwitch);

    store.set(prev => ({ ...prev, b: 8 }));
    await flush();
    expect(h.renders.at(-1)).toBe(8);
    h.unmount();
  });

  it('unsubscribes from all stores on unmount', async () => {
    const a = createStore({ v: 0 });
    const b = createStore({ v: 0 });
    const h = mount(() => {
      const [ra, rb] = useStores(a, b);
      return ra.v + rb.v;
    });
    await flush();
    h.unmount();
    await flush();
    const before = h.renders.length;
    a.set({ v: 99 });
    b.set({ v: 99 });
    await flush();
    expect(h.renders.length).toBe(before);
  });

  it('Object.is equality: set with identical reference does not re-render', async () => {
    const sameArray = [1, 2, 3];
    const store = createStore({ items: sameArray });
    const h = mount(() => {
      const [s] = useStores(store);
      return s.items;
    });
    await flush();
    const before = h.renders.length;
    store.set({ items: sameArray });
    await flush();
    expect(h.renders.length).toBe(before);
    h.unmount();
  });

  it('rename via destructuring preserves tracking', async () => {
    const store = createStore({ phase: 'idle', count: 0 });
    const h = mount(() => {
      const [{ phase: current }] = useStores(store);
      return current;
    });
    await flush();
    const before = h.renders.length;
    store.set(prev => ({ ...prev, count: 99 }));
    await flush();
    expect(h.renders.length).toBe(before);

    store.set(prev => ({ ...prev, phase: 'running' }));
    await flush();
    expect(h.renders.at(-1)).toBe('running');
    h.unmount();
  });
});
