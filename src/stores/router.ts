import { createStore, storeBase } from './create-store.js';
import { feedbackStore } from './feedback.js';
import type { Screen, RouteData, Summary, WorkflowState } from '../types.js';
import { assertNever } from '../utils/type-guards.js';

const transitions: Record<Screen, Screen[]> = {
  home: ['workflow', 'setup'],
  workflow: ['summary', 'home'],
  summary: ['home', 'workflow'],
  setup: ['home', 'workflow'],
};

const initial: RouteData = { screen: 'home' };

const store = createStore<RouteData>(initial);

function navigate(to: Screen, data?: { feature?: string; summary?: Summary; resumeState?: WorkflowState; onComplete?: 'home' | 'workflow' }) {
  const current = store.get().screen;
  if (!transitions[current].includes(to)) {
    feedbackStore.setError(`Cannot navigate from "${current}" to "${to}"`);
    return;
  }

  switch (to) {
    case 'home':
      store.set({ screen: 'home' });
      break;
    case 'workflow':
      store.set({ screen: 'workflow', feature: data?.feature ?? '', resumeState: data?.resumeState });
      break;
    case 'summary':
      if (!data?.summary) throw new Error('Summary data required');
      store.set({ screen: 'summary', summary: data.summary });
      break;
    case 'setup':
      store.set({ screen: 'setup', onComplete: data?.onComplete, feature: data?.feature });
      break;
    default:
      assertNever(to);
  }
}

export const routerStore = {
  ...storeBase(store),
  navigate,
  init: (route: RouteData) => store.set(route),
};
