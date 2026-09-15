import type { Session } from '../../core/schemas/session.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OwnedResumeState } from '../../core/state/resume-hydration.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { OverlayType } from '../../core/navigation/types.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
import { readRunRecord } from '../../core/sessions/run-record-io.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { clearActiveReceipt } from '../../core/sessions/active-pointer.js';
import { rollbackPreparedSession } from '../../core/sessions/prepare.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';
import { createStore, storeBase } from '../create-store.js';
import { feedbackStore } from '../ui/feedback.js';
import { overlayStore } from '../ui/overlay.js';
import { routerStore } from './router.js';

type SessionResumePreparationState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'preparing' }>
  | Readonly<{ kind: 'blocked'; report: ReadinessReport }>
  | Readonly<{
      kind: 'failed';
      report?: ReadinessReport | undefined;
      error: Error;
    }>;

interface SessionSelectState {
  error: string | null;
  preparation: SessionResumePreparationState;
}

const initial: SessionSelectState = { error: null, preparation: { kind: 'idle' } };
const store = createStore<SessionSelectState>(initial);

type PreparationRequest = Readonly<{
  record: RunRecord;
  state: WorkflowState;
  /** What the operator typed to continue this run; it rides into the first step's own prompt. */
  steer?: string | undefined;
  deps: SessionSelectDeps;
  returnOverlay: OverlayType;
}>;

type ActiveAttempt = Readonly<{
  id: number;
  key: string;
  controller: AbortController;
  request: PreparationRequest;
  promise: Promise<void>;
}>;

let attemptId = 0;
let activeAttempt: ActiveAttempt | undefined;
let lastRequest: PreparationRequest | undefined;

function setSelectionError(error: string) {
  store.set((state) => ({ ...state, error }));
}

function clearSelectionError() {
  store.set((state) => (state.error === null ? state : { ...state, error: null }));
}

export const sessionSelectStore = {
  ...storeBase(store),
  clearError: clearSelectionError,
  reset: resetSessionSelection,
};

export interface SessionSelectDeps {
  /**
   * The classifying saved-state loader, supplied by the preparation composition
   * root. One dependency answers both the value and the reason it is absent, so
   * the message the picker renders is the seam's answer.
   */
  loadResumeState: (ref: SessionRef) => OwnedResumeState;
  prepareResume: (
    input: Readonly<{ ref: SessionRef; state: WorkflowState }>,
    signal: AbortSignal,
  ) => Promise<PreparationOutcome>;
  /** Replays a run's history into the workflow stores; the feature layer owns the replay itself. */
  hydrateRun: (record: RunRecord) => Promise<void>;
  cancelPendingApproval?: (() => void) | undefined;
}

function preparationError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Tool preparation failed.');
}

function dismissOverlays(): void {
  while (overlayStore.get().active !== 'none') overlayStore.close();
}

function reportCleanupFailure(cause: unknown): void {
  feedbackStore.setError(`Could not clean up tool preparation: ${toErrorMessage(cause)}`);
}

function discardPreparedResume(execution: PreparedExecution): void {
  try {
    if (execution.session.kind === 'existing') {
      clearActiveReceipt(execution.session.ref, execution.session.active);
      return;
    }
    rollbackPreparedSession({
      ref: execution.session.ref,
      ownership: execution.session.ownership,
    });
  } catch (cause) {
    reportCleanupFailure(cause);
  }
}

function isCurrentAttempt(id: number, controller: AbortController): boolean {
  return (
    attemptId === id &&
    activeAttempt?.id === id &&
    activeAttempt.controller === controller &&
    !controller.signal.aborted
  );
}

function finishAttempt(id: number): void {
  if (activeAttempt?.id === id) activeAttempt = undefined;
}

/**
 * Prepare this run's tools and hand it to the screen it is already on. The workflow screen is the
 * run's home whether it is moving or not, so a continuation flips the execution in place: nothing
 * navigates, and the transcript the replay put on screen stays where it is.
 */
export function continueRunInPlace(
  input: Readonly<{
    record: RunRecord;
    state: WorkflowState;
    steer?: string | undefined;
    deps: SessionSelectDeps;
  }>,
): Promise<void> {
  return beginPreparation({
    record: input.record,
    state: input.state,
    ...(input.steer !== undefined && { steer: input.steer }),
    deps: input.deps,
    returnOverlay: overlayStore.get().active,
  });
}

function beginPreparation(request: PreparationRequest): Promise<void> {
  const { projectDir, sessionId } = request.record.ref;
  const key = `${projectDir}\0${sessionId}`;
  if (activeAttempt?.key === key) return activeAttempt.promise;

  activeAttempt?.controller.abort();
  activeAttempt?.request.deps.cancelPendingApproval?.();
  const controller = new AbortController();
  const id = attemptId + 1;
  attemptId = id;
  lastRequest = request;
  dismissOverlays();
  store.set({ error: null, preparation: { kind: 'preparing' } });

  const ref = { projectDir, sessionId };
  const promise = Promise.resolve()
    .then(() => request.deps.prepareResume({ ref, state: request.state }, controller.signal))
    .then(
      (outcome) => {
        if (!isCurrentAttempt(id, controller)) {
          if (outcome.kind === 'prepared') discardPreparedResume(outcome.execution);
          return;
        }

        switch (outcome.kind) {
          case 'prepared':
            routerStore.updateRun({
              run: request.record,
              execution: {
                kind: 'local',
                prepared: outcome.execution,
                ...(request.steer !== undefined && { steer: request.steer }),
              },
            });
            lastRequest = undefined;
            store.set({ error: null, preparation: { kind: 'idle' } });
            return;
          case 'blocked':
            store.set({ error: null, preparation: { kind: 'blocked', report: outcome.report } });
            return;
          case 'failed':
            store.set({
              error: null,
              preparation: {
                kind: 'failed',
                ...(outcome.report !== undefined && { report: outcome.report }),
                error: outcome.error,
              },
            });
            return;
          case 'aborted':
            store.set({ error: null, preparation: { kind: 'idle' } });
            return;
          default:
            return assertNever(outcome);
        }
      },
      (cause: unknown) => {
        if (!isCurrentAttempt(id, controller)) return;
        store.set({
          error: null,
          preparation: { kind: 'failed', error: preparationError(cause) },
        });
      },
    )
    .finally(() => finishAttempt(id));

  activeAttempt = { id, key, controller, request, promise };
  return promise;
}

export function retrySessionPreparation(): Promise<void> {
  if (activeAttempt) return activeAttempt.promise;
  if (!lastRequest) return Promise.resolve();
  return beginPreparation(lastRequest);
}

export function cancelSessionPreparation(options: { restoreOrigin?: boolean } = {}): void {
  const request = activeAttempt?.request ?? lastRequest;
  attemptId += 1;
  activeAttempt?.controller.abort();
  activeAttempt?.request.deps.cancelPendingApproval?.();
  activeAttempt = undefined;
  lastRequest = undefined;
  store.set({ error: null, preparation: { kind: 'idle' } });
  if (options.restoreOrigin !== false && request && request.returnOverlay !== 'none') {
    dismissOverlays();
    overlayStore.open(request.returnOverlay);
  }
}

function resetSessionSelection(): void {
  cancelSessionPreparation({ restoreOrigin: false });
  store.reset();
}

/**
 * Opening a run is one thing whatever the run did: read its record, replay its history, and show it
 * on the workflow screen at rest. Only a run this process is already driving refuses — two local
 * runs cannot share one screen.
 */
export async function handleSessionSelect(
  session: Session,
  projectDir: string,
  deps: SessionSelectDeps,
): Promise<void> {
  const feature = sanitizeTerminalDisplayText(session.feature);
  const route = routerStore.get();
  if (route.screen === 'workflow' && route.execution.kind === 'local') {
    setSelectionError(`Cannot open "${feature}": stop the run on screen first.`);
    return;
  }

  const record = readRunRecord({ projectDir, sessionId: session.id });
  clearSelectionError();
  dismissOverlays();
  await deps.hydrateRun(record);
  routerStore.navigate({ to: 'workflow', run: record, execution: { kind: 'at-rest' } });
}
