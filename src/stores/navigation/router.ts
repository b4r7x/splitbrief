import { createStore, storeBase } from '../create-store.js';
import { feedbackStore } from '../ui/feedback.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { Screen } from '../../core/navigation/types.js';

export { ALL_SCREENS } from '../../core/navigation/types.js';
export type { OverlayType, Screen } from '../../core/navigation/types.js';

export type InputMode = 'normal' | 'review' | 'question';

export type WorkflowAttach = {
  sockPath: string;
};

export type RouteData =
  | { screen: 'home' }
  | { screen: 'workflow'; feature: string; resumeState?: WorkflowState | undefined; sessionId?: string | undefined; worktreeName?: string | undefined; attach?: WorkflowAttach | undefined; readiness?: ReadinessReport | undefined }
  | { screen: 'summary'; summary: Summary; sessionId?: string | undefined }
  | { screen: 'setup'; onComplete?: 'home' | 'workflow' | undefined; feature?: string | undefined };

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
  | { to: 'workflow'; feature: string; resumeState?: WorkflowState | undefined; sessionId?: string | undefined; worktreeName?: string | undefined; attach?: WorkflowAttach | undefined; readiness?: ReadinessReport | undefined }
  | { to: 'summary'; summary: Summary; sessionId?: string | undefined }
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
        worktreeName: args.worktreeName,
        attach: args.attach,
        readiness: args.readiness,
      });
      return;
    case 'summary':
      store.set({ screen: 'summary', summary: args.summary, sessionId: args.sessionId });
      return;
    case 'setup':
      store.set({
        screen: 'setup',
        onComplete: args.onComplete,
        feature: args.feature,
      });
      return;
  }
}

export const routerStore = {
  ...storeBase(store),
  navigate,
  init: (route: RouteData) => store.set(route),
};
