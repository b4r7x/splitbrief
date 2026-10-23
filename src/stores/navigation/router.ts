import { createStore, storeBase } from '../create-store.js';
import { publishFeedbackError, publishFeedbackReset } from '../channels/feedback.js';
import { assertNever } from '../../utils/type-guards.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
import { applyUnfinished } from '../../core/sessions/run-status.js';
import type { AttachedInput } from '../../core/schemas/attachment.js';
import type { Screen } from '../../core/navigation/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import type { UserMessageInput } from '../../core/types/user-input.js';

/**
 * Whether a process in this session is running the run on screen. `at-rest` is a run read back from
 * disk — live or finished, the workflow screen is the same screen.
 */
export type WorkflowExecution =
  | Readonly<{
      kind: 'local';
      prepared: PreparedExecution;
      /** What the operator typed to continue this run; it seeds the first step of this re-entry. */
      steer?: UserMessageInput | undefined;
    }>
  | Readonly<{ kind: 'at-rest' }>;

type WorkflowPayload = {
  /** Read at navigation and refreshed with its history when session files change at rest. */
  run: RunRecord;
  execution: WorkflowExecution;
};
type SetupPayload = {
  onComplete?: 'home' | 'workflow' | undefined;
  feature?: string | undefined;
  plannerContext?: string | undefined;
  attachedInputs?: readonly AttachedInput[] | undefined;
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
        ...(args.attachedInputs !== undefined && { attachedInputs: args.attachedInputs }),
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

/** A run read back from disk that is open and no process holds: its screen can continue it or end it. */
export function isOpenRunAtRest(route: RouteData): boolean {
  return (
    route.screen === 'workflow' &&
    route.execution.kind === 'at-rest' &&
    route.run.status.kind !== 'closed' &&
    route.run.status.kind !== 'running'
  );
}

/** An open run at rest whose Apply did not finish: its screen can continue it, not end it. */
export function isApplyUnfinishedAtRest(route: RouteData): boolean {
  return (
    route.screen === 'workflow' &&
    isOpenRunAtRest(route) &&
    route.run.hydration.kind === 'loaded' &&
    applyUnfinished(route.run.hydration.state)
  );
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
  currentSelection: () => selection,
  isCurrentSelection: (generation: number) => generation === selection,
  init: (route: RouteData) => {
    supersede();
    store.set(route);
  },
};
