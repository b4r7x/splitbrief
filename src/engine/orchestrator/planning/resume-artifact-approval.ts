import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { PLAN_FILE, SPEC_FILE, sessionDir } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import { getWorkflowMode } from '../../../core/config/accessors/values.js';
import {
  blocksPlanGate,
  blocksSpecGate,
  resolveApproveLevel,
} from '../../../core/config/runtime/resolve.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError } from '../events.js';
import { runApprovalLoop } from '../approval/loop.js';

const ARTIFACT_FILES = {
  'reviewing-spec': SPEC_FILE,
  'reviewing-plan': PLAN_FILE,
} as const;

export async function resumeArtifactApproval(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  state: WorkflowState;
  phase: 'reviewing-spec' | 'reviewing-plan';
}): Promise<{ state: WorkflowState; cancelled: boolean; regenerated: boolean }> {
  const { wctx, state, phase } = opts;
  const { projectDir, sessionId, config, bus, planner } = wctx;
  const filename = ARTIFACT_FILES[phase];
  const ref = { projectDir, sessionId };

  if (readSpecFile(ref, filename) === null) {
    publishError({
      bus,
      phase: state.phase,
      message: `Cannot resume ${phase}: ${filename} is missing from the session directory`,
      safety: { category: 'planning', code: 'artifact_not_restorable' },
    });
    return { state, cancelled: true, regenerated: false };
  }

  const approveLevel = resolveApproveLevel({
    mode: getWorkflowMode(config),
    configApprove: config.workflow.approve,
  });
  const blocksGate =
    phase === 'reviewing-spec' ? blocksSpecGate(approveLevel) : blocksPlanGate(approveLevel);
  if (!blocksGate) return { state, cancelled: false, regenerated: false };

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
  });

  return {
    state: loop.state,
    cancelled: loop.rejected || loop.aborted === true,
    regenerated: loop.regenerated,
  };
}
