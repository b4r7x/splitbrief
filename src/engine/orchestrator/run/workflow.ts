import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { SpecMetadata } from '../../../core/sessions/spec-files.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { pruneOrphanSessions } from '../../../core/sessions/orphans.js';
import { recordRunnerPid, releaseRunnerPid } from '../../../core/sessions/runner-pids.js';
import { runSeatIdentity } from '../../../core/providers/seat-identity.js';
import { resolveSpecMetadata } from '../../providers/model/display-names.js';
import { NULL_CACHE } from '../../providers/model/runtime-snapshot.js';
import {
  createProcessScope,
  currentProcessScope,
  killProcessScope,
  runInProcessScope,
  setProcessLedger,
  type ProcessScope,
} from '../../../lib/process/registry.js';
import { error } from '../../../utils/error.js';

import { bindCheckoutSandbox } from '../../runners/sandbox/env.js';
import type { PreparedConfig } from '../../runners/prepare-execution/prepared.js';
import { summaryBaseFromIdentity } from '../summary/seat-identity.js';
import { publishWarning } from '../publish/notice.js';
import { publishInfo } from '../publish/notice.js';
import { publishDebug } from '../publish/notice.js';
import { withShutdownHandlers } from '../session-lifecycle/shutdown.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';

import type { RunWorkflowOptions } from './init/options.js';
import { getIsolationStrategy } from '../../../core/config/accessors/values.js';
import { reapOrphanRunners } from './orphan-reaper.js';
import { acquireLiveness } from './liveness.js';
import { runBody, type ClaimedRunState } from './body.js';
import { settleRun } from './settle.js';
import { teardownRun } from './teardown.js';
import { trackedPhase } from './tracker.js';
import type { RunTracker, ScopedRun } from './types.js';
import { followCommittedState } from '../state-ops/commit.js';
import { readWorkflowStateHead } from '../state-ops/head.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { continueRunCommand } from '../../../core/recovery/resume-command.js';

function resolveSessionStart(savedState: WorkflowState | undefined): number {
  if (!savedState) return Date.now();
  const original = Date.parse(savedState.startedAt);
  return Number.isNaN(original) ? Date.now() : original;
}

function readClaimedRunState(
  prepared: RunWorkflowOptions['prepared'],
  requestedState: WorkflowState | undefined,
): ClaimedRunState {
  const { purpose, session } = prepared;
  const { ref, active } = session;
  let state: WorkflowState | undefined;
  try {
    state = readWorkflowStateHead(ref)?.state;
  } catch (cause) {
    if (purpose === 'new-workflow') throw cause;
    return { kind: 'unreadable', cause };
  }
  if (purpose === 'new-workflow') {
    if (state === undefined || state.phase === 'idle')
      return { kind: 'loaded', savedState: undefined };
    throw error(
      'workflow-session-already-started',
      `Internal invariant: session ${ref.sessionId} already holds workflow state at phase ${state.phase}; a new-workflow run requires a freshly allocated session.`,
      { sessionId: ref.sessionId, phase: state.phase },
    );
  }
  if (state !== undefined) {
    const status = deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false });
    if (status.kind === 'closed') {
      throw error(
        'workflow-session-already-closed',
        `Run ${ref.sessionId} is closed (${status.as}); nothing to resume.`,
        { sessionId: ref.sessionId, as: status.as },
      );
    }
    if (
      status.kind === 'ready-to-apply' &&
      (requestedState === undefined ||
        deriveRunStatus({
          state: requestedState,
          liveness: 'not-alive',
          reviewNone: false,
        }).kind !== 'ready-to-apply')
    ) {
      const action = state.acceptedAsIs === undefined ? 'apply' : 'apply-as-is';
      throw error(
        'workflow-session-ready-to-apply',
        `Run ${ref.sessionId} is ready to apply. Run '${continueRunCommand(ref.sessionId)} --action ${action}' to apply it.`,
        { sessionId: ref.sessionId },
      );
    }
  }
  if (purpose === 'resume') reactivateExistingSession(ref, active);
  return { kind: 'loaded', savedState: state };
}

/**
 * A run inside the TUI run loop shares the loop's process scope, so a stop between engine passes
 * ends the processes of both; a run started on its own gets a scope of its own.
 */
export function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const processScope = currentProcessScope() ?? createProcessScope();
  return runInProcessScope(processScope, () => runScopedWorkflow(opts, processScope));
}

async function runScopedWorkflow(
  opts: RunWorkflowOptions,
  processScope: ProcessScope,
): Promise<Summary> {
  const { runtime, session } = opts.prepared;
  const config = opts.prepared.config;
  const feature = runtime.feature;
  const projectDir = session.ref.projectDir;
  const sessionId = session.ref.sessionId;
  const requestedSavedState = opts.savedState ?? runtime.resumeState;
  // A boundary interrupt raised before this run started (Esc-Esc in a dead zone
  // of a previous run that then ended into recovery without passing a call
  // boundary) is stale: drain it so it cannot park this run's first call
  // boundary on an interrupt nobody requested.
  opts.sinks.consumeBoundaryInterrupt?.();
  const startTime = resolveSessionStart(requestedSavedState);
  const summaryBase = summaryBaseFromIdentity(runSeatIdentity(config), {
    feature,
    startTime,
    projectDir,
    sessionId,
  });

  const metadata: SpecMetadata = resolveSpecMetadata(config, opts.modelCache ?? NULL_CACHE);

  const tracker: RunTracker = {
    state: undefined,
    currentTask: undefined,
    result: undefined,
    bus: undefined,
  };

  await reapOrphanRunners(projectDir);
  pruneOrphanSessions({ projectDir });

  const releaseLiveness = await acquireLiveness({
    projectDir,
    sessionId,
    feature,
  });
  let entry: ClaimedRunState;
  try {
    entry = readClaimedRunState(opts.prepared, requestedSavedState);
  } catch (cause) {
    await releaseLiveness();
    throw cause;
  }

  const ref = { projectDir, sessionId };
  const processLedger = {
    // A null start time is recorded as null: the orphan reaper refuses to kill
    // entries without start-time identity, which a 0 sentinel would defeat.
    record: (pid: number, startTimeMs: number | null) => recordRunnerPid(ref, pid, startTimeMs),
    release: (pid: number) => releaseRunnerPid(ref, pid),
  };
  setProcessLedger(processLedger);

  const run: ScopedRun = {
    opts,
    processScope,
    ref,
    config,
    feature,
    startTime,
    summaryBase,
    metadata,
    isolation: createTrackedIsolation(ref, config, feature, tracker),
    processLedger,
    releaseLiveness,
  };

  const unbindCheckoutSandbox = bindCheckoutSandbox(processScope, ref);
  let stopFollowingState: (() => void) | undefined;
  try {
    // A head a nested call commits reaches the tracked state too, so no event is stamped with
    // the phase the run has already left.
    stopFollowingState = followCommittedState(ref, (state) => {
      tracker.state = state;
    });
    const { cancelled } = await withShutdownHandlers(
      {
        projectDir,
        sessionId,
        getTrackedState: () => tracker.state,
        getCurrentTask: () => tracker.currentTask,
      },
      () => runBody(run, tracker, entry),
    );

    // Every way out of the run body ends the same way: nothing it spawned outlives it, and the
    // summary lands only once those processes are gone — a child still running when the summary
    // appears could read a record of a run it is still part of.
    await killProcessScope(processScope);

    return await settleRun(run, tracker, cancelled);
  } finally {
    unbindCheckoutSandbox();
    await teardownRun(run, tracker, stopFollowingState);
  }
}

// Run-scoped isolation, built before init and disposed in the teardown. The notice callbacks
// resolve the bus and phase late, from the tracker.
function createTrackedIsolation(
  ref: SessionRef,
  config: PreparedConfig,
  feature: string,
  tracker: RunTracker,
): RunIsolation {
  return createRunIsolation({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    strategy: getIsolationStrategy(config),
    onFallback: (reason: string): void => {
      const bus = tracker.bus;
      if (!bus) return;
      publishDebug({
        bus,
        phase: trackedPhase(tracker, feature),
        message: `Isolation worktree unavailable; falling back to a staged copy: ${reason}`,
      });
    },
    warningPublisher: (message: string): void => {
      const bus = tracker.bus;
      if (!bus) return;
      publishWarning({
        bus,
        phase: trackedPhase(tracker, feature),
        message,
      });
    },
    infoPublisher: (row): void => {
      const bus = tracker.bus;
      if (!bus) return;
      publishInfo({
        bus,
        phase: trackedPhase(tracker, feature),
        ...row,
      });
    },
  });
}
