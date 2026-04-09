import { useSyncExternalStore } from 'react';

type Listener = () => void;
type Updater<T> = T | ((prev: T) => T);

export interface Store<T> {
  get: () => T;
  set: (updater: Updater<T>) => void;
  subscribe: (listener: Listener) => () => void;
  use: <S>(selector: (state: T) => S) => S;
  reset: (state?: T) => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
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

  const use = <S>(selector: (s: T) => S): S =>
    useSyncExternalStore(subscribe, () => selector(get()));

  const reset = (next?: T) => set(next ?? initial);

  return { get, set, subscribe, use, reset };
}

export const storeBase = <T>(s: Store<T>) => ({ use: s.use, get: s.get, reset: s.reset });
