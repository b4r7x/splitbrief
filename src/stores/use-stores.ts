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
  const accessedRef = useRef<Set<string>[]>(stores.map(() => new Set<string>()));
  const snapshotsRef = useRef<unknown[]>(stores.map(s => s.get()));
  const tupleRef = useRef<unknown[]>(snapshotsRef.current);

  const subscribe = (cb: () => void) => {
    const unsubs = stores.map(s => s.subscribe(cb));
    return () => {
      for (const u of unsubs) u();
    };
  };

  const getSnapshot = (): Stores<T> => {
    let anyChanged = false;
    const next: unknown[] = [];
    for (let i = 0; i < stores.length; i++) {
      const store = stores[i]!;
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

  const raw = useSyncExternalStore(subscribe, getSnapshot);

  return stores.map((_, i) => {
    const fresh = new Set<string>();
    accessedRef.current[i] = fresh;
    return new Proxy(raw[i] as object, {
      get(target, prop) {
        if (typeof prop === 'string') fresh.add(prop);
        return (target as Record<PropertyKey, unknown>)[prop];
      },
    });
  }) as unknown as Stores<T>;
}
