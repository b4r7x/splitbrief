import { createStore, storeBase } from '../create-store.js';
import { publishFeedbackError, publishFeedbackReset } from '../channels/feedback.js';
import { assertNever } from '../../utils/type-guards.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
import type { Screen } from '../../core/navigation/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';

/**
 * Whether a process in this session is running the run on screen. `at-rest` is a run read back from
 * disk — live or finished, the workflow screen is the same screen.
 */
export type WorkflowExecution =
  | Readonly<{
      kind: 'local';
      prepared: PreparedExecution;
      /** What the operator typed to continue this run; it seeds the first step of this re-entry. */
      steer?: string | undefined;
    }>
  | Readonly<{ kind: 'at-rest' }>;

type WorkflowPayload = {
  /** Read once at the navigation event: the screen does no IO of its own. */
  run: RunRecord;
  execution: WorkflowExecution;
};
type SetupPayload = {
  onComplete?: 'home' | 'workflow' | undefined;
  feature?: string | undefined;
  plannerContext?: string | undefined;
  allowRepoRunners?: boolean | undefined;
};

export type RouteData =
  | { screen: 'home' }
  | ({ screen: 'workflow' } & WorkflowPayload)
  | ({ screen: 'setup' } & SetupPayload);

const transitions: Record<Screen, Screen[]> = {
  home: ['workflow', 'setup'],
  workflow: ['workflow', 'home'],
  setup: ['home', 'workflow'],
};

const initial: RouteData = { screen: 'home' };

const store = createStore<RouteData>(initial);

/**
 * Which change of the screen's owner is the latest. A history read captures it before touching the
 * disk and publishes only if nothing newer — a select, start, continue, navigation or reset — has
 * taken the screen while it was reading.
 */
let selection = 0;

function supersede(): number {
  selection += 1;
  return selection;
}

export type NavigateArgs =
  | { to: 'home' }
  | ({ to: 'workflow' } & WorkflowPayload)
  | ({ to: 'setup' } & SetupPayload);

function navigate(args: NavigateArgs) {
  const current = store.get().screen;
  const to = args.to;
  if (!transitions[current].includes(to)) {
    publishFeedbackError(`Cannot navigate from "${current}" to "${to}"`);
    return;
  }

  publishFeedbackReset();
  supersede();

  switch (args.to) {
    case 'home':
      store.set({ screen: 'home' });
      return;
    case 'workflow':
      store.set({
        screen: 'workflow',
        run: args.run,
        execution: args.execution,
      });
      return;
    case 'setup':
      store.set({
        screen: 'setup',
        onComplete: args.onComplete,
        feature: args.feature,
        plannerContext: args.plannerContext,
        allowRepoRunners: args.allowRepoRunners,
      });
      return;
    default:
      return assertNever(args);
  }
}

/**
 * The run on screen, re-read. The record is the one home for a run's status, so a command or a
 * finished loop that changes it hands the screen the new record rather than a second fact.
 * The execution is kept unless the caller says it changed.
 */
function updateRun(input: Readonly<{ run: RunRecord; execution?: WorkflowExecution | undefined }>) {
  const current = store.get();
  if (
    current.screen !== 'workflow' ||
    current.run.ref.projectDir !== input.run.ref.projectDir ||
    current.run.ref.sessionId !== input.run.ref.sessionId
  )
    return;
  store.set({
    screen: 'workflow',
    run: input.run,
    execution: input.execution ?? current.execution,
  });
}

export const routerStore = {
  ...storeBase(store),
  reset: () => {
    supersede();
    store.reset();
  },
  navigate,
  updateRun,
  supersede,
  isCurrentSelection: (generation: number) => generation === selection,
  init: (route: RouteData) => {
    supersede();
    store.set(route);
  },
};
