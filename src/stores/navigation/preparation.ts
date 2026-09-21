import type { ReadinessReport } from '../../core/readiness/types.js';
import { clearActiveReceipt } from '../../core/sessions/active-pointer.js';
import { rollbackPreparedSession } from '../../core/sessions/prepare.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { assertNever } from '../../utils/type-guards.js';
import { createStore, storeBase } from '../create-store.js';
import { routerStore } from './router.js';

export type PreparationOrigin = 'start' | 'continue';

type AttemptFacts = Readonly<{
  attempt: number;
  origin: PreparationOrigin;
  /** A short label for the status beside the composer. */
  stage: string;
}>;

export type PreparationState =
  | Readonly<{ kind: 'idle' }>
  | (AttemptFacts & Readonly<{ kind: 'checking' }>)
  | (AttemptFacts & Readonly<{ kind: 'blocked'; report: ReadinessReport }>)
  | (AttemptFacts &
      Readonly<{ kind: 'failed'; report?: ReadinessReport | undefined; error: Error }>);

export type PreparationRequest = Readonly<{
  origin: PreparationOrigin;
  stage: string;
  /** A submit carrying the key of the attempt still checking joins that attempt instead of replacing it. */
  key?: string | undefined;
  prepare: (signal: AbortSignal) => Promise<PreparationOutcome>;
  /** The synchronous handoff, called only while this attempt is still the current one. */
  onPrepared: (execution: PreparedExecution) => void;
  /** Called when a newer submit or a cancel abandons this attempt while it is checking. */
  onAbandoned?: (() => void) | undefined;
}>;

type Checking = Readonly<{
  attempt: number;
  selection: number;
  controller: AbortController;
  request: PreparationRequest;
  promise: Promise<void>;
}>;

export const CHECKING_TOOLS_STAGE = 'Checking tools';

const store = createStore<PreparationState>({ kind: 'idle' });
let lastAttempt = 0;
let checking: Checking | undefined;

function preparationError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Tool preparation failed.');
}

/** A superseded result gives back exactly the receipt it claimed, never whatever replaced it. */
function rollbackStale(execution: PreparedExecution): void {
  if (execution.session.kind === 'existing') {
    clearActiveReceipt(execution.session.ref, execution.session.active);
    return;
  }
  rollbackPreparedSession({ ref: execution.session.ref, ownership: execution.session.ownership });
}

function abandonChecking(): void {
  if (checking === undefined) return;
  const { controller, request } = checking;
  checking = undefined;
  controller.abort();
  request.onAbandoned?.();
}

function settle(facts: AttemptFacts, request: PreparationRequest, outcome: PreparationOutcome) {
  cancelSupersededSelection(facts.attempt);
  if (checking?.attempt !== facts.attempt) {
    if (outcome.kind === 'prepared') rollbackStale(outcome.execution);
    return;
  }
  checking = undefined;

  switch (outcome.kind) {
    case 'prepared':
      try {
        request.onPrepared(outcome.execution);
        store.set({ kind: 'idle' });
      } catch (cause) {
        store.set({
          ...facts,
          kind: 'failed',
          report: outcome.execution.report,
          error: preparationError(cause),
        });
      }
      return;
    case 'blocked':
      store.set({ ...facts, kind: 'blocked', report: outcome.report });
      return;
    case 'failed':
      store.set({
        ...facts,
        kind: 'failed',
        ...(outcome.report !== undefined && { report: outcome.report }),
        error: outcome.error,
      });
      return;
    case 'aborted':
      store.set({ kind: 'idle' });
      return;
    default:
      return assertNever(outcome);
  }
}

function cancelSupersededSelection(attempt: number): void {
  if (checking?.attempt === attempt && !routerStore.isCurrentSelection(checking.selection)) {
    cancel(attempt);
  }
}

/**
 * Start or continue preparation. The newest submit owns the screen: it aborts whatever attempt is
 * still checking, and only its own result may hand off, block or fail. The promise rejects only
 * when a superseded result cannot roll back the ownership it claimed.
 */
function submit(request: PreparationRequest) {
  if (request.key !== undefined && checking?.request.key === request.key) {
    return { attempt: checking.attempt, promise: checking.promise, joined: true };
  }

  abandonChecking();
  lastAttempt += 1;
  const facts = { attempt: lastAttempt, origin: request.origin, stage: request.stage };
  const controller = new AbortController();
  const promise = Promise.resolve()
    .then(() => request.prepare(controller.signal))
    .then(
      (outcome) => settle(facts, request, outcome),
      (cause: unknown) => {
        cancelSupersededSelection(facts.attempt);
        if (checking?.attempt !== facts.attempt) return;
        checking = undefined;
        store.set({ ...facts, kind: 'failed', error: preparationError(cause) });
      },
    );

  checking = {
    attempt: facts.attempt,
    selection: routerStore.supersede(),
    controller,
    request,
    promise,
  };
  store.set({ ...facts, kind: 'checking' });
  return { attempt: facts.attempt, promise, joined: false };
}

/** Cancels the attempt only while it is the current one; returns whether it was. */
function cancel(attempt: number): boolean {
  const state = store.get();
  if (state.kind === 'idle' || state.attempt !== attempt) return false;
  abandonChecking();
  store.set({ kind: 'idle' });
  return true;
}

export const preparationStore = {
  ...storeBase(store),
  submit,
  cancel,
  reset: () => {
    abandonChecking();
    store.reset();
  },
};
