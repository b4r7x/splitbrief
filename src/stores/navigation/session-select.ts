import type { Session } from '../../core/schemas/session.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OwnedResumeState } from '../../core/state/resume-hydration.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { OverlayType } from '../../core/navigation/types.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
import { readRunRecord } from '../../core/sessions/run-record-io.js';
import type { PreparationOutcome } from '../../engine/runners/prepared-execution.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { createStore, storeBase } from '../create-store.js';
import { skillsStore } from '../project/skills.js';
import { feedbackStore } from '../ui/feedback.js';
import { overlayStore } from '../ui/overlay.js';
import { CHECKING_TOOLS_STAGE, preparationStore, type PreparationState } from './preparation.js';
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
  steer?: UserMessageInput | undefined;
  deps: SessionSelectDeps;
  returnOverlay: OverlayType;
}>;

let continuing: Readonly<{ attempt: number; promise: Promise<void> }> | undefined;
let lastRequest: PreparationRequest | undefined;

const IDLE: SessionResumePreparationState = { kind: 'idle' };

/** The picker's view of the shared coordinator: only a continuation is this store's to show. */
function resumePreparation(state: PreparationState): SessionResumePreparationState {
  if (state.kind === 'idle' || state.origin !== 'continue') return IDLE;
  switch (state.kind) {
    case 'checking':
      return { kind: 'preparing' };
    case 'blocked':
      return { kind: 'blocked', report: state.report };
    case 'failed':
      return {
        kind: 'failed',
        ...(state.report !== undefined && { report: state.report }),
        error: state.error,
      };
  }
}

preparationStore.subscribe(() => {
  const preparation = resumePreparation(preparationStore.get());
  store.set((state) =>
    state.preparation.kind === 'idle' && preparation === IDLE ? state : { ...state, preparation },
  );
});

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
  /**
   * Reads a run's history without touching a store and returns the step that publishes it, so a
   * selection superseded while it read writes nothing. Without it a selection falls back to
   * `hydrateRun`.
   */
  readRunHistory?: ((record: RunRecord) => Promise<() => void>) | undefined;
  cancelPendingApproval?: (() => void) | undefined;
}

function dismissOverlays(): void {
  while (overlayStore.get().active !== 'none') overlayStore.close();
}

function reportCleanupFailure(cause: unknown): void {
  feedbackStore.setError(`Could not clean up tool preparation: ${toErrorMessage(cause)}`);
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
    steer?: UserMessageInput | undefined;
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
  const ref = { projectDir, sessionId };
  const handle = preparationStore.submit({
    origin: 'continue',
    stage: CHECKING_TOOLS_STAGE,
    key: `${projectDir}\0${sessionId}`,
    prepare: (signal) => request.deps.prepareResume({ ref, state: request.state }, signal),
    onPrepared: (execution) => {
      routerStore.updateRun({
        run: request.record,
        execution: {
          kind: 'local',
          prepared: execution,
          ...(request.steer !== undefined && { steer: request.steer }),
        },
      });
      lastRequest = undefined;
    },
    onAbandoned: request.deps.cancelPendingApproval,
  });
  if (handle.joined && continuing?.attempt === handle.attempt) return continuing.promise;

  lastRequest = request;
  clearSelectionError();
  dismissOverlays();
  const promise = handle.promise.catch(reportCleanupFailure);
  continuing = { attempt: handle.attempt, promise };
  return promise;
}

export function retrySessionPreparation(): Promise<void> {
  const state = preparationStore.get();
  if (continuing && state.kind === 'checking' && state.attempt === continuing.attempt) {
    return continuing.promise;
  }
  if (!lastRequest) return Promise.resolve();
  return beginPreparation(lastRequest);
}

export function cancelSessionPreparation(options: { restoreOrigin?: boolean } = {}): void {
  const request = lastRequest;
  const current = preparationStore.get();
  const ownsCurrent = current.kind === 'idle' || current.attempt === continuing?.attempt;
  if (ownsCurrent) routerStore.supersede();
  if (continuing) preparationStore.cancel(continuing.attempt);
  continuing = undefined;
  lastRequest = undefined;
  if (
    ownsCurrent &&
    options.restoreOrigin !== false &&
    request &&
    request.returnOverlay !== 'none'
  ) {
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
 * runs cannot share one screen. The history is published only if this is still the latest selection
 * once the read lands, so a slow older run never paints over a newer one.
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
  cancelSessionPreparation({ restoreOrigin: false });
  preparationStore.reset();
  const generation = routerStore.supersede();
  clearSelectionError();
  dismissOverlays();
  let publish = () => {};
  if (deps.readRunHistory) publish = await deps.readRunHistory(record);
  else await deps.hydrateRun(record);
  if (!routerStore.isCurrentSelection(generation)) return;
  const current = routerStore.get();
  if (current.screen === 'workflow' && current.execution.kind === 'local') return;
  publish();
  // Continuing the run carries the skills it saved, never the last run's selection.
  if (record.hydration.kind === 'loaded') {
    skillsStore.setSelected(new Set(record.hydration.state.selectedSkills ?? []));
  }
  routerStore.navigate({ to: 'workflow', run: record, execution: { kind: 'at-rest' } });
}
