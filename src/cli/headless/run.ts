import { configuredReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { resolveReviewCadence } from '../../core/config/runtime/resolve.js';
import type { Config } from '../../core/schemas/config.js';
import { deriveRunStatus } from '../../core/sessions/run/status.js';
import type { SkillMeta } from '../../core/skills/types.js';
import type { SeatDownPolicy } from '../../core/types/config-options.js';
import { boundEngineEventForConsumer } from '../../engine/events/bound.js';
import type { Implementer } from '../../engine/implementers/types.js';
import { runWorkflow } from '../../engine/orchestrator/run/workflow.js';
import type { Planner } from '../../engine/planners/types.js';
import type { prepareExecution } from '../../engine/runners/prepare-execution/prepare.js';
import type { PreparationPolicy } from '../../engine/runners/prepare-execution/types.js';
import type { PreparedExecution } from '../../engine/runners/prepare-execution/prepared.js';
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
import {
  loadOwnedState,
  publishHandoffNotice,
  takeDecidedStep,
  takeResumePreflight,
} from './recovery-step.js';
import { takeAutomaticSeatSwap } from './seat-swap.js';
import { withHeadlessStop, writeRunStopped } from './stop.js';
import type { HeadlessRun } from './types.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
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

/** One workflow pass on the run's preparation; under `--plain` it keeps the pass's last error. */
async function runPass(
  run: HeadlessRun,
  options: RunHeadlessOptions,
  signal: AbortSignal,
): Promise<void> {
  run.lastError = undefined;
  await runWorkflow({
    prepared: run.prepared,
    headless: true,
    sinks: buildNoopSinks(),
    modelCache: modelCacheStore,
    drainPendingAttachments: () => attachmentsStore.drain(),
    signal,
    ...(run.plain && {
      plain: true,
      tuiSink: (event) => {
        if (event.type !== 'error') return;
        const bounded = boundEngineEventForConsumer(event, 'stdout-text');
        if (bounded.type === 'error') run.lastError = bounded.message;
      },
    }),
    selectedSkills: options.selectedSkills,
    _planner: options._planner,
    _implementer: options._implementer,
    savedState: run.savedState,
    callbacks: {
      onApprovalNeeded: async (_type, _input) => ({ approved: true, unattended: true }),
      onComplete: () => undefined,
    },
  });
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const projectDir = options.prepared.session.ref.projectDir;
  const sessionId = options.prepared.session.ref.sessionId;
  installTerminalOutputErrorGuard();
  const run: HeadlessRun = {
    ref: { projectDir, sessionId },
    plain: options.plain === true,
    onSeatDown: options.onSeatDown,
    writeRecord: recordWriterFor(options.plain === true),
    prepared: options.prepared,
    savedState: options.prepared.runtime.resumeState,
    lastError: undefined,
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
    for (;;) {
      await takeAutomaticSeatSwap(run, swapPolicy, signal, options._prepare);
      if (await takeResumePreflight(run)) break;
      await runPass(run, options, signal);
      if (signal.aborted) return;

      // Another seat went down with its own intent, or a halt has a decided step: take it and
      // re-enter. The loop ends when neither is pending.
      const next = loadOwnedState(run.ref);
      if (options.onSeatDown !== 'halt' && next?.pendingRecovery?.switchSeat?.auto !== undefined)
        continue;
      const decided = await takeDecidedStep(run, next);
      if (decided?.ok !== true || decided.status === 'closed') break;
      run.savedState = decided.state;
    }
  });

  if (stopped) {
    const state = loadOwnedState(run.ref);
    await publishHandoffNotice(run, state);
    if (
      state !== null &&
      deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }).kind === 'open'
    )
      writeRunStopped(sessionId);
    return;
  }

  const finalState = loadOwnedState(run.ref);
  await publishHandoffNotice(run, finalState);
  emitRecoveryAndFailIfPending({
    state: finalState,
    sessionId,
    reviewNone: resolveReviewCadence(options.prepared.config) === 'none',
    writeRecord: run.writeRecord,
  });
  // A review accepted as is keeps its failed verdict: the run is ready to apply or closed, and the
  // exit still says the review failed.
  const ready = emitReadyToApply(finalState, sessionId, run.writeRecord);
  failIfFinalReviewFailed(finalState, projectDir, sessionId, run.writeRecord);
  if (ready) return;
  const status =
    finalState === null
      ? null
      : deriveRunStatus({ state: finalState, liveness: 'not-alive', reviewNone: false });
  if (status?.kind === 'closed' && status.as === 'complete') return;
  failIfSessionFailed(finalState, sessionId, run.writeRecord, run.lastError);
  failIfFinalReviewIncomplete(finalState, sessionId, run.writeRecord);
  failIfSessionInterrupted(projectDir, sessionId, run.writeRecord);
}
