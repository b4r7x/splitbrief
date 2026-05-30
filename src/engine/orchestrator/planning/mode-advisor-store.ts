import type { AdvisorResult } from './mode-advisor.js';

interface AdvisoryStore {
  get: () => AdvisorResult | null;
  set: (next: AdvisorResult | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function createAdvisoryStore(): AdvisoryStore {
  let current: AdvisorResult | null = null;
  const listeners = new Set<() => void>();

  return {
    get: () => current,
    set: (next) => {
      if (current === next) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const defaultAdvisoryStore = createAdvisoryStore();

export const setAdvisory = defaultAdvisoryStore.set;
export const getAdvisory = defaultAdvisoryStore.get;
export const subscribeAdvisory = defaultAdvisoryStore.subscribe;
