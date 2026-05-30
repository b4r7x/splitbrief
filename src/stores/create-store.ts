import { useRef, useSyncExternalStore } from 'react';

type Listener = () => void;
type Updater<T> = T | ((prev: T) => T);

export interface Store<T> {
  get: () => T;
  set: (updater: Updater<T>) => void;
  subscribe: (listener: Listener) => () => void;
  use: <S>(selector: (state: T) => S) => S;
  reset: () => void;
}

export function createStore<T>(initialOrFactory: T | (() => T)): Store<T> {
  const getInitial = (): T =>
    typeof initialOrFactory === 'function' ? (initialOrFactory as () => T)() : initialOrFactory;

  let state = getInitial();
  const listeners = new Set<Listener>();

  const notify = () => {
    listeners.forEach((listener) => {
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
    return () => {
      listeners.delete(listener);
    };
  };

  const use = <S>(selector: (s: T) => S): S => {
    const selectedRef = useRef<{ state: T; selector: (s: T) => S; selected: S } | null>(null);

    const getSnapshot = () => {
      const current = get();
      const cached = selectedRef.current;
      if (cached && Object.is(cached.state, current) && cached.selector === selector) {
        return cached.selected;
      }

      const selected = selector(current);
      selectedRef.current = { state: current, selector, selected };
      return selected;
    };

    return useSyncExternalStore(subscribe, getSnapshot);
  };

  const reset = () => set(getInitial());

  return { get, set, subscribe, use, reset };
}

export const storeBase = <T>(s: Store<T>) => ({
  use: s.use,
  get: s.get,
  subscribe: s.subscribe,
  reset: s.reset,
});
