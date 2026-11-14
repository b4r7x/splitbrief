import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { Summary } from '../../../core/schemas/summary.js';

import { buildSummary } from '../summary/build.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { ensureRunBaselineSnapshot } from './snapshots.js';
import { SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import { createSnapshot } from '../../snapshots/create.js';
import { reconcileWorkspaceToBase } from '../isolation/run-base/reader.js';
import { error } from '../../../utils/error.js';
import { hasBaseline } from '../../snapshots/manifest.js';
import { runCodeDir } from '../kept-work.js';
import { startBaseGate } from '../validation/base-gate.js';
import type { RunTasksAndReviewOptions } from './types.js';
import { buildAndReview } from './build-and-review.js';

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; state: WorkflowState }> {
  const { setTrackedState, setCurrentTask } = opts;
  const initialWctx = opts.wctx;
  const { summaryBase } = opts;
  let { state } = opts;
  const bail = () => ({
    summary: buildSummary({ ...summaryBase, state }),
    completed: false,
    state,
  });

  if (opts.planning.disposition !== 'ready-for-tasks') {
    return bail();
  }

  await ensureRunBaselineSnapshot({
    projectDir: initialWctx.projectDir,
    sessionId: initialWctx.sessionId,
    bus: initialWctx.bus,
    phase: state.phase,
  });

  const ref = { projectDir: initialWctx.projectDir, sessionId: initialWctx.sessionId };
  if (!(await hasBaseline(ref.projectDir, ref.sessionId))) {
    throw error(
      'run-baseline-snapshot-missing',
      'The run baseline snapshot could not be initialized; workspace acquisition stopped.',
    );
  }
  if (state.workspace === undefined) {
    const base = await createSnapshot({
      ...ref,
      phase: 'manual',
      name: 'workspace-base',
      bus: initialWctx.bus,
      eventPhase: state.phase,
    });
    if (base.manifest.id === SNAPSHOT_BASELINE_ID) {
      throw error(
        'run-workspace-base-is-baseline',
        'Workspace acquisition requires a snapshot distinct from the session baseline.',
      );
    }
    const opened = await initialWctx.isolation.open({ config: initialWctx.config });
    // The checkout is its own base: there is no second tree to bring level with it.
    if (opened.kind !== 'checkout') {
      await reconcileWorkspaceToBase({
        ...ref,
        snapshotId: base.manifest.id,
        workspaceDir: opened.projectDir,
        keep: opened.keptFiles,
      });
    }
    state = transitionAndSave(ref, state, {
      type: 'RECORD_WORKSPACE',
      workspace: {
        kind: opened.kind,
        path: opened.projectDir,
        base: { snapshotId: base.manifest.id, head: opened.head },
      },
    });
    setTrackedState(state);
  } else {
    const opened = await initialWctx.isolation.open({
      config: initialWctx.config,
      recorded: state.workspace.kind,
    });
    if (opened.projectDir !== state.workspace.path) {
      throw error(
        'run-workspace-moved',
        `The recorded run workspace at ${state.workspace.path} is gone or replaced; opening ${opened.projectDir} would create a second workspace.`,
      );
    }
  }
  const wctx = {
    ...initialWctx,
    workspaceDir: runCodeDir(initialWctx.projectDir, state.workspace),
  };
  let phase = state.phase;
  const trackState = (next: WorkflowState) => {
    phase = next.phase;
    setTrackedState(next);
  };
  const baseGate = startBaseGate({
    ref,
    workspaceDir: wctx.workspaceDir,
    config: wctx.config,
    bus: wctx.bus,
    state,
    phase: () => phase,
    signal: wctx.signal,
  });
  // The base run never outlives the run loop: it stops before the run's processes are killed, so a
  // killed base command is never stored as a red.
  try {
    return await buildAndReview({
      wctx: { ...wctx, baseGate },
      state,
      ref,
      summaryBase,
      setTrackedState: trackState,
      setCurrentTask,
    });
  } finally {
    await baseGate?.stop();
  }
}
