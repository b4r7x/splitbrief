import { createStore, storeBase } from '../create-store.js';
import { feedbackStore } from '../ui/feedback.js';
import type { Screen, RouteData, Summary, WorkflowState } from '../../types.js';
import { assertNever } from '../../utils/type-guards.js';

const transitions: Record<Screen, Screen[]> = {
  home: ['workflow', 'setup'],
  workflow: ['summary', 'home'],
  summary: ['home', 'workflow'],
  setup: ['home', 'workflow'],
};

const initial: RouteData = { screen: 'home' };

const store = createStore<RouteData>(initial);

export type NavigateArgs =
  | { to: 'home' }
  | { to: 'workflow'; feature: string; resumeState?: WorkflowState | undefined; sessionId?: string | undefined }
  | { to: 'summary'; summary: Summary }
  | { to: 'setup'; onComplete?: 'home' | 'workflow' | undefined; feature?: string | undefined };

function navigate(args: NavigateArgs) {
  const current = store.get().screen;
  const to = args.to;
  if (!transitions[current].includes(to)) {
    feedbackStore.setError(`Cannot navigate from "${current}" to "${to}"`);
    return;
  }

  switch (args.to) {
    case 'home':
      store.set({ screen: 'home' });
      return;
    case 'workflow':
      store.set({
        screen: 'workflow',
        feature: args.feature,
        resumeState: args.resumeState,
        sessionId: args.sessionId,
      });
      return;
    case 'summary':
      store.set({ screen: 'summary', summary: args.summary });
      return;
    case 'setup':
      store.set({
        screen: 'setup',
        onComplete: args.onComplete,
        feature: args.feature,
      });
      return;
    default:
      assertNever(args);
  }
}

export const routerStore = {
  ...storeBase(store),
  navigate,
  init: (route: RouteData) => store.set(route),
};
