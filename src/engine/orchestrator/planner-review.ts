import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import type { SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE } from '../../core/paths.js';
import { createBusTextHandler } from './events.js';
import { addUsageAndSave } from './state-ops.js';

export type RunPlannerReviewOptions = {
  planner: Planner;
  prompt: string;
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  metadata?: SpecMetadata | null | undefined;
  writeTo?: typeof SPEC_FILE | typeof PLAN_FILE | typeof TASKS_FILE | typeof REVIEW_FILE;
  signal?: AbortSignal | undefined;
};

export async function runPlannerReview(
  opts: RunPlannerReviewOptions,
): Promise<{ state: WorkflowState; text: string }> {
  const { planner, prompt, projectDir, sessionId, bus, writeTo, metadata } = opts;
  const result = await planner.review(prompt, projectDir, {
    onOutput: createBusTextHandler({ bus: bus, phase: opts.state.phase }, { content: 'markdown' }),
    signal: opts.signal,
  });
  const state = addUsageAndSave(
    { projectDir, sessionId, bus },
    opts.state,
    'planner',
    result.usage,
  );
  if (writeTo) writeSpecFile({ projectDir, sessionId }, writeTo, result.text, metadata);
  return { state, text: result.text };
}
