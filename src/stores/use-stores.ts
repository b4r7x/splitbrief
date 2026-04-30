import { useRef, useSyncExternalStore } from 'react';

interface Subscribable<T> {
  get: () => T;
  subscribe: (listener: () => void) => () => void;
}

type StoreState<S> = S extends Subscribable<infer T> ? T : never;
type Stores<T extends readonly Subscribable<object>[]> = {
  [K in keyof T]: StoreState<T[K]>;
};

export function useStores<T extends readonly Subscribable<object>[]>(...stores: T): Stores<T> {
  const storesRef = useRef<T>(stores);
  const accessedRef = useRef<Set<string>[]>(stores.map(() => new Set<string>()));
  const snapshotsRef = useRef<unknown[]>(stores.map(s => s.get()));
  const tupleRef = useRef<unknown[]>(snapshotsRef.current);
  const subscribeRef = useRef<((cb: () => void) => () => void) | null>(null);

  const storesChanged = stores.length !== storesRef.current.length
    || stores.some((store, i) => store !== storesRef.current[i]);
  if (storesChanged) {
    storesRef.current = stores;
    accessedRef.current = stores.map(() => new Set<string>());
    snapshotsRef.current = stores.map(s => s.get());
    tupleRef.current = snapshotsRef.current;
    subscribeRef.current = null;
  }

  if (!subscribeRef.current) {
    subscribeRef.current = (cb: () => void) => {
      const unsubs = storesRef.current.map(s => s.subscribe(cb));
      return () => {
        for (const u of unsubs) u();
      };
    };
  }

  const getSnapshot = (): Stores<T> => {
    let anyChanged = false;
    const next: unknown[] = [];
    for (let i = 0; i < storesRef.current.length; i++) {
      const store = storesRef.current[i]!;
      const live = store.get();
      const prev = snapshotsRef.current[i];
      const accessed = accessedRef.current[i] ?? new Set<string>();

      if (prev !== undefined && accessed.size > 0) {
        let changed = false;
        for (const k of accessed) {
          const a = (prev as Record<string, unknown>)[k];
          const b = (live as Record<string, unknown>)[k];
          if (!Object.is(a, b)) {
            changed = true;
            break;
          }
        }
        next.push(changed ? live : prev);
        if (changed) anyChanged = true;
      } else {
        next.push(live);
        if (!Object.is(prev, live)) anyChanged = true;
      }
    }

    if (!anyChanged) return tupleRef.current as Stores<T>;
    snapshotsRef.current = next;
    tupleRef.current = next;
    return next as Stores<T>;
  };

  useSyncExternalStore(subscribeRef.current, getSnapshot);

  return storesRef.current.map((store, i) => {
    const fresh = new Set<string>();
    accessedRef.current[i] = fresh;
    return new Proxy({}, {
      get(_target, prop) {
        if (typeof prop === 'string') fresh.add(prop);
        return (store.get() as Record<PropertyKey, unknown>)[prop];
      },
      has(_target, prop) {
        return prop in store.get();
      },
      ownKeys() {
        return Reflect.ownKeys(store.get());
      },
      getOwnPropertyDescriptor(_target, prop) {
        const descriptor = Object.getOwnPropertyDescriptor(store.get(), prop);
        if (!descriptor) return undefined;
        return { ...descriptor, configurable: true };
      },
    });
  }) as unknown as Stores<T>;
}
