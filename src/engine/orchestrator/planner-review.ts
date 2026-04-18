import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from './types.js';
import type { Planner } from '../planners/types.js';
import { writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE } from '../../core/paths.js';
import { createTextHandler } from './events.js';
import { addUsageAndSave } from './state-ops.js';

export type RunPlannerReviewOptions = {
  planner: Planner;
  prompt: string;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
  metadata?: SpecMetadata | null | undefined;
  writeTo?: typeof SPEC_FILE | typeof PLAN_FILE | typeof TASKS_FILE | typeof REVIEW_FILE;
};

export async function runPlannerReview(
  opts: RunPlannerReviewOptions,
): Promise<{ state: WorkflowState; text: string }> {
  const { planner, prompt, projectDir, sessionId, callbacks, writeTo, metadata } = opts;
  const result = await planner.review(prompt, projectDir, {
    onOutput: createTextHandler(callbacks),
  });
  const state = addUsageAndSave(projectDir, sessionId, opts.state, 'planner', result.usage, callbacks);
  if (writeTo) writeSpecFile(projectDir, sessionId, writeTo, result.text, metadata);
  return { state, text: result.text };
}
