import { existsSync } from 'node:fs';
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
import { runBody } from './body.js';
import { settleRun } from './settle.js';
import { teardownRun } from './teardown.js';
import { trackedPhase } from './tracker.js';
import type { RunTracker, ScopedRun } from './types.js';
import { followCommittedState } from '../state-ops/commit.js';
import { readWorkflowStateHead } from '../state-ops/head.js';
import { sessionDir } from '../../../core/paths.js';

function resolveSessionStart(savedState: WorkflowState | undefined): number {
  if (!savedState) return Date.now();
  const original = Date.parse(savedState.startedAt);
  return Number.isNaN(original) ? Date.now() : original;
}

/**
 * A new-workflow run applies START, which the state machine accepts only from
 * `idle`. `prepareNewSession` allocates a session directory that cannot already
 * exist (a non-recursive mkdir plus an exclusive ownership marker), so a
 * new-workflow preparation serves only the run that starts its session. Every
 * later entry into that session is a resume: the TUI run loop prepares the
 * session again as `purpose: 'resume'` before it re-enters a run it started (a
 * halt answered in process, a rewind, a restart), and a seat swap, a continue at
 * rest and the CLI `continue` are resume preparations already. Refusing before
 * the run touches liveness, isolation, or state keeps a caller that breaks this
 * rule an internal invariant instead of a transition error raised half-way into
 * a session it then marks failed.
 */
function assertNewWorkflowSessionUnstarted(
  ref: Readonly<{ projectDir: string; sessionId: string }>,
): void {
  // A run whose session directory has not been created yet holds no state, and
  // reading the head would resolve a path that does not exist.
  if (!existsSync(sessionDir(ref.projectDir, ref.sessionId))) return;
  const head = readWorkflowStateHead(ref);
  if (head === null || head.state.phase === 'idle') return;
  throw error(
    'workflow-session-already-started',
    `Internal invariant: session ${ref.sessionId} already holds workflow state at phase ${head.state.phase}; a new-workflow run requires a freshly allocated session.`,
    { sessionId: ref.sessionId, phase: head.state.phase },
  );
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
  if (opts.prepared.purpose === 'new-workflow') {
    assertNewWorkflowSessionUnstarted({ projectDir, sessionId });
  }
  const requestedSavedState = opts.savedState ?? runtime.resumeState;
  // A boundary interrupt raised before this run started (Esc-Esc in a dead zone
  // of a previous run that then ended into recovery without passing a call
  // boundary) is stale: drain it so it cannot park this run's first call
  // boundary on an interrupt nobody requested.
  opts.sinks.consumeBoundaryInterrupt?.();
  const startTime = resolveSessionStart(requestedSavedState);
  // The run's display identity is the seat it is on now, so it comes from the
  // config and never from the saved state. The seat the tokens were spent
  // against is recorded in the state, and `buildSummary` prices the run from
  // there — a run that swapped seats mid-flight names the new one and is still
  // costed against the old one.
  const summaryBase = summaryBaseFromIdentity(runSeatIdentity(config), {
    feature,
    startTime,
    projectDir,
    sessionId,
    ...(opts.modelCache !== undefined && { pricingCache: opts.modelCache }),
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
    signal: opts.signal,
  });

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
      () => runBody(run, tracker),
    );

    // Every way out of the run body ends the same way: nothing it spawned outlives it, and the
    // summary lands only once those processes are gone — a child still running when the summary
    // appears could read a record of a run it is still part of.
    await killProcessScope(processScope);

    return await settleRun(run, tracker, cancelled);
  } finally {
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
