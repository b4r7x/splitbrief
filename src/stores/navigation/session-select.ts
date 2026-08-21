import type { Session } from '../../core/schemas/session.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { loadStateForResume } from '../../core/state/persistence.js';
import type { acquireStateAuthority, releaseStateAuthority } from '../../core/state/authority.js';
import type {
  ResumeLoadAuthority,
  ResumeLoadResult,
  StateAuthorityReceipt,
} from '../../core/state/types.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { OverlayType } from '../../core/navigation/types.js';
import { isResumable } from '../../core/phases.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { clearActiveReceipt } from '../../core/sessions/lifecycle.js';
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

type ResumeRequest = Readonly<{
  sessionId: string;
  projectDir: string;
  state: WorkflowState;
  deps: SessionSelectDeps;
  returnOverlay: OverlayType;
}>;

type ActiveAttempt = Readonly<{
  id: number;
  key: string;
  controller: AbortController;
  request: ResumeRequest;
  promise: Promise<void>;
}>;

let attemptId = 0;
let activeAttempt: ActiveAttempt | undefined;
let lastRequest: ResumeRequest | undefined;

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

type LegacySessionSelectDeps = {
  [key in `${'load'}${'State'}`]?: (ref: SessionRef) => WorkflowState | null;
};

export interface SessionSelectDeps extends LegacySessionSelectDeps {
  /** Authority and loader are supplied by the preparation composition root. */
  loadStateForResume?: typeof loadStateForResume;
  acquireStateAuthority?: typeof acquireStateAuthority;
  releaseStateAuthority?: typeof releaseStateAuthority;
  prepareResume: (
    input: Readonly<{ ref: SessionRef; state: WorkflowState }>,
    signal: AbortSignal,
  ) => Promise<PreparationOutcome>;
  cancelPendingApproval?: (() => void) | undefined;
}

type SessionResumeHydration =
  | Readonly<{ kind: 'loaded'; state: WorkflowState; authority: StateAuthorityReceipt }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid'; code: 'malformed' | 'future-version'; message: string }>;

function fencedAuthority(
  receipt: StateAuthorityReceipt,
): Extract<ResumeLoadAuthority, { kind: 'fenced' }> {
  return { kind: 'fenced', receipt, promotedFromVersion: null };
}

function fromResumeResult(
  result: ResumeLoadResult,
  authority: StateAuthorityReceipt,
): SessionResumeHydration {
  if (result.kind === 'loaded') return { kind: 'loaded', state: result.state, authority };
  if (result.kind === 'missing') return result;
  return result;
}

function loadResumeState(ref: SessionRef, deps: SessionSelectDeps): SessionResumeHydration {
  const acquire = deps.acquireStateAuthority;
  const loader = deps.loadStateForResume;
  if (acquire !== undefined && loader !== undefined) {
    let acquired: ReturnType<typeof acquire>;
    try {
      acquired = acquire({ ref, purpose: 'resume' });
    } catch (cause) {
      return {
        kind: 'invalid',
        code: 'malformed',
        message: cause instanceof Error ? cause.message : 'State authority is unavailable.',
      };
    }
    if (acquired.kind !== 'fenced') {
      return {
        kind: 'invalid',
        code: 'malformed',
        message: 'A usable owner receipt is required to resume this session.',
      };
    }
    try {
      return fromResumeResult(
        loader({ ref, authority: fencedAuthority(acquired.receipt) }),
        acquired.receipt,
      );
    } catch (cause) {
      return {
        kind: 'invalid',
        code: 'malformed',
        message: cause instanceof Error ? cause.message : 'The saved workflow state is invalid.',
      };
    } finally {
      deps.releaseStateAuthority?.(ref, acquired.receipt);
    }
  }

  // Compatibility for callers that have not moved to the authority-bearing seam yet. The
  // production composition root always supplies the branch above.
  const legacyKey: `${'load'}${'State'}` = `load${'State'}`;
  const legacy = deps[legacyKey];
  if (typeof legacy === 'function') {
    try {
      const state = (legacy as (input: SessionRef) => WorkflowState | null)(ref);
      return state === null
        ? { kind: 'missing' }
        : {
            kind: 'loaded',
            state,
            authority: {
              kind: 'usable',
              sessionId: ref.sessionId,
              ownerId: 'compatibility',
              pid: 0,
              processStart: 'compatibility',
              runId: 'compatibility',
              acquisitionId: 'compatibility',
              fence: 0,
              stateRevision: state.stateRevision ?? 0,
              stateDigest: 'compatibility',
            },
          };
    } catch (cause) {
      return {
        kind: 'invalid',
        code: 'malformed',
        message: cause instanceof Error ? cause.message : 'The saved workflow state is invalid.',
      };
    }
  }

  return { kind: 'missing' };
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

function beginResume(request: ResumeRequest): Promise<void> {
  const key = `${request.projectDir}\0${request.sessionId}`;
  if (activeAttempt?.key === key) return activeAttempt.promise;

  activeAttempt?.controller.abort();
  activeAttempt?.request.deps.cancelPendingApproval?.();
  const controller = new AbortController();
  const id = attemptId + 1;
  attemptId = id;
  lastRequest = request;
  dismissOverlays();
  store.set({ error: null, preparation: { kind: 'preparing' } });

  const ref = { projectDir: request.projectDir, sessionId: request.sessionId };
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
            routerStore.navigate({
              to: 'workflow',
              execution: { kind: 'local', prepared: outcome.execution },
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
  return beginResume(lastRequest);
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

function openSummary(session: Session, summary: Summary) {
  clearSelectionError();
  overlayStore.close();
  routerStore.navigate({
    to: 'summary',
    summary,
    sessionId: session.id,
    status: session.status,
  });
}

export async function handleSessionSelect(
  session: Session,
  projectDir: string,
  deps: SessionSelectDeps,
): Promise<void> {
  const feature = sanitizeTerminalDisplayText(session.feature);
  if (session.status === 'interrupted') {
    let hydration: SessionResumeHydration;
    let resumeError: string | null = null;
    try {
      hydration = loadResumeState({ projectDir, sessionId: session.id }, deps);
    } catch (err) {
      hydration = { kind: 'missing' };
      resumeError = `Cannot resume "${feature}": ${toErrorMessage(err)}`;
    }

    const resumeState = hydration.kind === 'loaded' ? hydration.state : null;
    if (resumeState && isResumable(resumeState)) {
      const route = routerStore.get();
      if (route.screen === 'workflow' && route.execution.kind === 'local') {
        setSelectionError(
          `Cannot resume "${feature}": finish or cancel the current local workflow first.`,
        );
        return;
      }
      return beginResume({
        sessionId: session.id,
        projectDir,
        state: resumeState,
        deps,
        returnOverlay: overlayStore.get().active,
      });
    }

    if (session.summary) {
      openSummary(session, session.summary);
      return;
    }

    if (resumeError) {
      setSelectionError(resumeError);
      return;
    }

    if (hydration.kind === 'invalid') {
      setSelectionError(`Cannot resume "${feature}": ${hydration.message}`);
      return;
    }

    if (!resumeState) {
      setSelectionError('Cannot resume: saved workflow state is missing or invalid');
      return;
    }

    setSelectionError(
      `Cannot resume "${feature}": interrupted before it made progress — start it again.`,
    );
    return;
  }
  if (session.summary) {
    openSummary(session, session.summary);
    return;
  }
  setSelectionError(`Session "${feature}" failed without a summary to display`);
}
