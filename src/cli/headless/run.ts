import { configuredReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { resolveReviewCadence } from '../../core/config/runtime/resolve.js';
import { haltOf } from '../../core/recovery/halt.js';
import type { Config } from '../../core/schemas/config.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import { isAnsweredApplyRecovery, deriveRunStatus } from '../../core/sessions/run/status.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { loadOwnerWorkflowState } from '../../core/state/resume-hydration.js';
import type { SeatDownPolicy } from '../../core/types/config-options.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { boundEngineEventForConsumer } from '../../engine/events/bound.js';
import type { Implementer } from '../../engine/implementers/types.js';
import { publishRetainedWorkspaceNotice } from '../../engine/orchestrator/isolation/retention.js';
import { applyDecidedRecovery } from '../../engine/orchestrator/recovery/actions.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
import { applyOfferedSeatSwap } from '../../engine/orchestrator/run/seat-swap.js';
import { runWorkflow } from '../../engine/orchestrator/run/workflow.js';
import type { Planner } from '../../engine/planners/types.js';
import type { prepareExecution } from '../../engine/runners/prepare-execution/prepare-execution.js';
import type { PreparationPolicy } from '../../engine/runners/prepare-execution/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { installTerminalOutputErrorGuard } from '../../lib/terminal/control.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { cliError } from '../errors.js';
import {
  recordWriterFor,
  emitRecoveryAndFailIfPending,
  emitReadyToApply,
  failIfFinalReviewFailed,
  failIfSessionFailed,
  failIfFinalReviewIncomplete,
  failIfSessionInterrupted,
} from './outcome.js';
import { withHeadlessStop, writeRunStopped } from './stop.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
}

function loadOwnedState(ref: SessionRef): WorkflowState | null {
  const hydrated = loadOwnerWorkflowState(ref);
  if (hydrated.kind !== 'loaded') return null;
  return hydrated.state;
}

export interface RunHeadlessOptions {
  prepared: PreparedExecution;
  /** `--plain`: render the run as plain lines instead of NDJSON records. */
  plain?: boolean | undefined;
  /** `--skills`: the resolved skills every seat of this run carries. */
  selectedSkills?: SkillMeta[] | undefined;
  /** `--on-seat-down`: how a seat-down halt is answered. Unset defers to the seat's fallback. */
  onSeatDown?: SeatDownPolicy | undefined;
  /** `--allow-unverified-auth`: admit a swapped-in seat on unverified auth as the first run did. */
  allowUnverifiedAuth?: boolean | undefined;
  _planner?: Planner | undefined;
  _implementer?: Implementer | undefined;
  /** Tests: the preparation the seat swap drives, so no real engine is needed. */
  _prepare?: typeof prepareExecution | undefined;
}

/** Whether any seat — the three live ones and every build profile — declares a fallback. */
export function configDeclaresFallback(config: Config): boolean {
  const reviewer = configuredReviewerRunner(config);
  const runners = [
    config.planner,
    config.implementer,
    ...(reviewer !== undefined ? [reviewer] : []),
    ...Object.values(config.implementerProfiles?.profiles ?? {}),
  ];
  return runners.some((runner) => runner.fallback !== undefined);
}

/**
 * The terms the swapped-in seat is admitted under: the run's own, as a headless
 * resume. The seat swap is the run loop's re-entry, so it prepares the way the
 * first headless admission did — hooks and repo runners as the run had them,
 * unverified auth only when the operator asked for it.
 */
function headlessResumePolicy(
  prepared: PreparedExecution,
  allowUnverifiedAuth: boolean,
): Extract<PreparationPolicy, { purpose: 'resume' }> {
  return {
    purpose: 'resume',
    interaction: 'headless',
    allowRepoRunners: prepared.runtime.allowRepoRunners,
    allowHooks: prepared.runtime.allowHooks,
    unverifiedAuth: allowUnverifiedAuth ? 'allowed' : 'denied',
    modelCache: modelCacheStore,
  };
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const { plain, selectedSkills, _planner, _implementer } = options;
  const projectDir = options.prepared.session.ref.projectDir;
  const sessionId = options.prepared.session.ref.sessionId;
  installTerminalOutputErrorGuard();
  const writeRecord = recordWriterFor(plain === true);
  let lastError: string | undefined;
  const publishHandoffNotice = async (state: WorkflowState | null): Promise<void> => {
    if (state === null) return;
    await publishRetainedWorkspaceNotice({
      projectDir,
      sessionId,
      state,
      bus: createRecoveryBus({
        projectDir,
        sessionId,
        sink: (event) => {
          const bounded = boundEngineEventForConsumer(event, 'stdout-text');
          if (plain === true && (bounded.type === 'warning' || bounded.type === 'error'))
            process.stderr.write(`${bounded.message}\n`);
          else writeRecord({ type: 'event', data: event });
        },
      }),
    });
  };

  // The handlers are installed before the pending-halt preflight: the preflight
  // reads state and may stop, and an operator's interrupt must still land while
  // it does.
  const { stopped } = await withHeadlessStop(async (signal) => {
    // An explicit `switch` with nothing to switch to is a usage error, named for
    // the word the operator would have to add to the config.
    if (options.onSeatDown === 'switch' && !configDeclaresFallback(options.prepared.config)) {
      throw cliError(
        '`--on-seat-down switch` needs a seat that declares `fallback`; this config declares none.',
        2,
      );
    }

    const swapPolicy = headlessResumePolicy(options.prepared, options.allowUnverifiedAuth === true);
    let prepared = options.prepared;
    let savedState = prepared.runtime.resumeState;
    const recoveryBus = () =>
      createRecoveryBus({
        projectDir,
        sessionId,
        sink: (event) => writeRecord({ type: 'event', data: event }),
      });
    // After Decide for me, a halt with a decided step takes it here as the TUI takes it; under
    // `--on-seat-down halt` a seat down still stops the run.
    const takeDecidedStep = async (state: WorkflowState | null) =>
      state === null ||
      (options.onSeatDown === 'halt' &&
        state.pendingRecovery !== undefined &&
        haltOf(state.pendingRecovery.reason) === 'seat-down')
        ? undefined
        : applyDecidedRecovery(
            {
              projectDir,
              sessionId,
              state,
              bus: recoveryBus(),
              config: prepared.config,
            },
            () => prepared.config,
            undefined,
          );

    for (;;) {
      // The automatic intent a halt left is taken before the run that would hit the
      // same seat again: an admitted swap resolves the halt and prepares this
      // session on the new seat, so `runWorkflow`'s re-entry runs on it.
      const before = loadOwnedState({ projectDir, sessionId });
      const auto = before?.pendingRecovery?.switchSeat?.auto;
      if (before !== null && auto !== undefined && options.onSeatDown !== 'halt') {
        const swapped = await applyOfferedSeatSwap({
          choice: { candidate: auto.candidate, policy: swapPolicy },
          projectDir,
          sessionId,
          bus: recoveryBus(),
          config: prepared.config,
          prepared,
          savedState: before,
          signal,
          ...(options._prepare !== undefined && { prepare: options._prepare }),
        });
        if (swapped !== undefined) {
          prepared = swapped.prepared;
          savedState = swapped.state;
        }
        // A swap that did not resolve the halt leaves the same intent pending; there
        // is no picker headlessly, so the halt is reported exactly as one no one
        // answered and the run stops.
        const after = loadOwnedState({ projectDir, sessionId });
        if (after !== null && after.pendingRecovery?.switchSeat?.auto !== undefined) {
          await publishHandoffNotice(after);
          emitRecoveryAndFailIfPending({
            state: after,
            sessionId,
            reviewNone: resolveReviewCadence(prepared.config) === 'none',
            writeRecord,
          });
        }
      }

      // A resumed session with a pending recovery is already an owner-controlled
      // state machine. A headless observation must report it, not manufacture a
      // retry by entering the ordinary workflow loop (which would invoke a
      // planner/provider).
      if (prepared.purpose === 'resume') {
        const halted = loadOwnedState({ projectDir, sessionId });
        const decided = await takeDecidedStep(halted);
        if (decided?.ok === true && decided.status === 'closed') break;
        if (decided?.ok === true) savedState = decided.state;
        const preflight = decided?.state ?? halted;
        if (preflight !== null) {
          if (
            preflight.pendingRecovery !== undefined &&
            !isAnsweredApplyRecovery(preflight.pendingRecovery)
          )
            await publishHandoffNotice(preflight);
          emitRecoveryAndFailIfPending({
            state: preflight,
            sessionId,
            reviewNone: resolveReviewCadence(prepared.config) === 'none',
            writeRecord,
          });
        }
      }

      lastError = undefined;
      await runWorkflow({
        prepared,
        headless: true,
        sinks: buildNoopSinks(),
        modelCache: modelCacheStore,
        drainPendingAttachments: () => attachmentsStore.drain(),
        signal,
        ...(plain === true && {
          plain: true,
          tuiSink: (event) => {
            if (event.type !== 'error') return;
            const bounded = boundEngineEventForConsumer(event, 'stdout-text');
            if (bounded.type === 'error') lastError = bounded.message;
          },
        }),
        selectedSkills,
        _planner,
        _implementer,
        savedState,
        callbacks: {
          onApprovalNeeded: async (_type, _input) => ({ approved: true, unattended: true }),
          onComplete: () => undefined,
        },
      });

      if (signal.aborted) return;

      // Another seat went down with its own intent, or a halt has a decided step: take it and
      // re-enter. The loop ends when neither is pending.
      const next = loadOwnedState({ projectDir, sessionId });
      if (options.onSeatDown !== 'halt' && next?.pendingRecovery?.switchSeat?.auto !== undefined)
        continue;
      const decided = await takeDecidedStep(next);
      if (decided?.ok !== true || decided.status === 'closed') break;
      savedState = decided.state;
    }
  });

  if (stopped) {
    const state = loadOwnedState({ projectDir, sessionId });
    await publishHandoffNotice(state);
    if (
      state !== null &&
      deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }).kind === 'open'
    )
      writeRunStopped(sessionId);
    return;
  }

  const finalState = loadOwnedState({ projectDir, sessionId });
  await publishHandoffNotice(finalState);
  emitRecoveryAndFailIfPending({
    state: finalState,
    sessionId,
    reviewNone: resolveReviewCadence(options.prepared.config) === 'none',
    writeRecord,
  });
  // A review accepted as is keeps its failed verdict: the run is ready to apply or closed, and the
  // exit still says the review failed.
  const ready = emitReadyToApply(finalState, sessionId, writeRecord);
  failIfFinalReviewFailed(finalState, projectDir, sessionId, writeRecord);
  if (ready) return;
  const status =
    finalState === null
      ? null
      : deriveRunStatus({ state: finalState, liveness: 'not-alive', reviewNone: false });
  if (status?.kind === 'closed' && status.as === 'complete') return;
  failIfSessionFailed(finalState, sessionId, writeRecord, lastError);
  failIfFinalReviewIncomplete(finalState, sessionId, writeRecord);
  failIfSessionInterrupted(projectDir, sessionId, writeRecord);
}
