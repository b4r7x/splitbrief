import { useSyncExternalStore } from 'react';

type Listener = () => void;
type Updater<T> = T | ((prev: T) => T);

interface Store<T> {
  get: () => T;
  set: (updater: Updater<T>) => void;
  subscribe: (listener: Listener) => () => void;
  use: <S>(selector: (state: T) => S) => S;
  reset: (state?: T) => void;
}

const isDev = typeof process !== 'undefined' && process.env?.['NODE_ENV'] === 'development';
const checkedSelectors = new WeakSet<(s: unknown) => unknown>();

export function createStore<T>(initialOrFactory: T | (() => T)): Store<T> {
  const getInitial = (): T =>
    typeof initialOrFactory === 'function' ? (initialOrFactory as () => T)() : initialOrFactory;

  let state = getInitial();
  const listeners = new Set<Listener>();

  const notify = () => {
    listeners.forEach(listener => {
      listener();
    });
  };

  const get = () => state;

  const set = (updater: Updater<T>) => {
    const next = typeof updater === 'function' ? (updater as (prev: T) => T)(state) : updater;
    if (Object.is(state, next)) return;
    state = next;
    notify();
  };

  const subscribe = (listener: Listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  const use = <S>(selector: (s: T) => S): S => {
    if (isDev && !checkedSelectors.has(selector as (s: unknown) => unknown)) {
      checkedSelectors.add(selector as (s: unknown) => unknown);
      const a = selector(state);
      const b = selector(state);
      if (!Object.is(a, b)) {
        console.warn(
          '[store] Unstable selector detected: returns different object on consecutive calls with same state. ' +
          'This will cause infinite re-renders. Selector:',
          selector.toString().slice(0, 100),
        );
      }
    }
    return useSyncExternalStore(subscribe, () => selector(get()));
  };

  const reset = (next?: T) => set(next ?? getInitial());

  return { get, set, subscribe, use, reset };
}

export const storeBase = <T>(s: Store<T>) => ({ use: s.use, get: s.get, reset: s.reset });
