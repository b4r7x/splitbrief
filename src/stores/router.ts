import { createStore, storeBase } from './create-store.js';
import type { Screen, RouteData, Summary, WorkflowState } from '../types.js';

const transitions: Record<Screen, Screen[]> = {
  home: ['workflow'],
  workflow: ['summary', 'home'],
  summary: ['home', 'workflow'],
};

const initial: RouteData = { screen: 'home' };

const store = createStore<RouteData>(initial);

function navigate(to: Screen, data?: { feature?: string; summary?: Summary; resumeState?: WorkflowState }) {
  const current = store.get().screen;
  if (!transitions[current].includes(to)) {
    throw new Error(`Cannot navigate from "${current}" to "${to}"`);
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
  }
}

export const routerStore = {
  ...storeBase(store),
  navigate,
  init: (route: RouteData) => store.set(route),
};
