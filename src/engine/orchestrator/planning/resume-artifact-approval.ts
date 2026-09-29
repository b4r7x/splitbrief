import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { PLAN_FILE, SPEC_FILE, sessionDir } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import { resolveApproveLevel, resolveMode } from '../../../core/config/runtime/resolve.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError } from '../events.js';
import { runApprovalLoop } from '../approval/loop.js';
import { plannerStepsFor } from '../../../core/pipeline-spec/steps.js';

const ARTIFACT_FILES = {
  'reviewing-spec': SPEC_FILE,
  'reviewing-plan': PLAN_FILE,
} as const;

export async function resumeArtifactApproval(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  state: WorkflowState;
  phase: 'reviewing-spec' | 'reviewing-plan';
}): Promise<{ state: WorkflowState; closed: boolean; cancelled: boolean; regenerated: boolean }> {
  const { wctx, state, phase } = opts;
  const { projectDir, sessionId, config, bus, planner } = wctx;
  const filename = ARTIFACT_FILES[phase];
  const ref = { projectDir, sessionId };

  // The gate opens at the run's own mode and level, resolved as planning resolves them (`run.ts`).
  // The steps after the gate read both from the state returned here (`runPlanningSteps`), so it
  // carries them even when the run saved neither.
  const mode = resolveMode({ config, savedMode: state.mode });
  const approveLevel = resolveApproveLevel({
    mode,
    configApprove: config.workflow.approve,
    savedApprove: state.approve,
  });
  const gate = phase === 'reviewing-spec' ? 'spec' : 'plan';
  const blocksGate = plannerStepsFor(mode, approveLevel).some((step) => step.gateAfter === gate);
  if (!blocksGate) {
    return {
      state: { ...state, mode, approve: approveLevel },
      closed: false,
      cancelled: false,
      regenerated: false,
    };
  }

  if (readSpecFile(ref, filename) === null) {
    publishError({
      bus,
      phase: state.phase,
      message: `Cannot resume ${phase}: ${filename} is missing from the session directory`,
      safety: { category: 'planning', code: 'artifact_not_restorable' },
    });
    return { state, closed: false, cancelled: true, regenerated: false };
  }

  const loop = await runApprovalLoop({
    type: phase === 'reviewing-spec' ? 'spec' : 'plan',
    filePath: join(sessionDir(projectDir, sessionId), filename),
    planner,
    projectDir,
    sessionId,
    callbacks: wctx.callbacks,
    bus,
    state,
    signal: wctx.signal,
    specMetadata: wctx.metadata,
    sinks: wctx.sinks,
    ...(wctx.skillsContext !== undefined && { skillsContext: wctx.skillsContext }),
  });

  // Carry the effective settings through a loop that may read a newer disk head.
  return {
    state: { ...loop.state, mode, approve: approveLevel },
    closed: loop.closed,
    cancelled: loop.aborted === true,
    regenerated: loop.regenerated,
  };
}
