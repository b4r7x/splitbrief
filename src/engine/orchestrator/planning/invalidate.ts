import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import type { PlannerStepArtifact } from '../../../core/pipeline-spec/steps.js';
import type { PlannerCall } from '../../../core/schemas/run-step.js';

const DOWNSTREAM: Partial<Record<PlannerCall, readonly PlannerStepArtifact[]>> = {
  research: [
    SPEC_FILE,
    CLARIFICATIONS_FILE,
    CONSTITUTION_CHECK_FILE,
    PLAN_FILE,
    TASKS_FILE,
    ANALYZE_FILE,
  ],
  spec: [CLARIFICATIONS_FILE, CONSTITUTION_CHECK_FILE, PLAN_FILE, TASKS_FILE, ANALYZE_FILE],
  plan: [TASKS_FILE, ANALYZE_FILE],
  tasks: [ANALYZE_FILE],
};

/**
 * Drops the artifacts a revised call invalidates, so the step loop re-runs the
 * calls that produced them. The revised artifact itself stays: it is the input
 * the downstream calls read.
 */
export function invalidateFrom(
  ref: { projectDir: string; sessionId: string },
  call: PlannerCall,
): readonly PlannerStepArtifact[] {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const dropped: PlannerStepArtifact[] = [];
  for (const artifact of DOWNSTREAM[call] ?? []) {
    rmSync(join(dir, artifact), { force: true });
    dropped.push(artifact);
  }
  return dropped;
}
