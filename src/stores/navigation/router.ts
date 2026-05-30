import { createStore, storeBase } from '../create-store.js';
import { publishFeedbackError } from '../shared/feedback-events.js';
import { assertNever } from '../../utils/type-guards.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { Screen } from '../../core/navigation/types.js';

export type WorkflowAttach = {
  sockPath: string;
};

type WorkflowPayload = {
  feature: string;
  plannerContext?: string | undefined;
  resumeState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  worktreeName?: string | undefined;
  attach?: WorkflowAttach | undefined;
  readiness?: ReadinessReport | undefined;
};
type SummaryPayload = { summary: Summary; sessionId?: string | undefined };
type SetupPayload = {
  onComplete?: 'home' | 'workflow' | undefined;
  feature?: string | undefined;
  plannerContext?: string | undefined;
};

export type RouteData =
  | { screen: 'home' }
  | ({ screen: 'workflow' } & WorkflowPayload)
  | ({ screen: 'summary' } & SummaryPayload)
  | ({ screen: 'setup' } & SetupPayload);

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
  | ({ to: 'workflow' } & WorkflowPayload)
  | ({ to: 'summary' } & SummaryPayload)
  | ({ to: 'setup' } & SetupPayload);

function navigate(args: NavigateArgs) {
  const current = store.get().screen;
  const to = args.to;
  if (!transitions[current].includes(to)) {
    publishFeedbackError(`Cannot navigate from "${current}" to "${to}"`);
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
        plannerContext: args.plannerContext,
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
        plannerContext: args.plannerContext,
      });
      return;
    default:
      return assertNever(args);
  }
}

export const routerStore = {
  ...storeBase(store),
  navigate,
  init: (route: RouteData) => store.set(route),
};
