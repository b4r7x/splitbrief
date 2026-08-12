import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, type REVIEW_FILE } from '../../core/paths.js';
import { createBusTextHandler } from './events.js';
import { writeAndPublishArtifact } from './artifact-write.js';
import { addUsageAndSave } from './state-ops.js';

// Reviewed planning documents reach the transcript as an artifact card once written, never as a
// body paste. review.md has no gate and no review column, so it still streams.
const CARDED_ARTIFACTS: ReadonlySet<string> = new Set([SPEC_FILE, PLAN_FILE, TASKS_FILE]);

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
  const carded = writeTo !== undefined && CARDED_ARTIFACTS.has(writeTo);
  const result = await planner.review(prompt, projectDir, {
    onOutput: carded
      ? () => {}
      : createBusTextHandler({ bus: bus, phase: opts.state.phase }, { content: 'markdown' }),
    signal: opts.signal,
  });
  const state = addUsageAndSave(
    { projectDir, sessionId, bus },
    opts.state,
    'planner',
    result.usage,
  );
  if (writeTo) {
    if (carded) {
      writeAndPublishArtifact({
        projectDir,
        sessionId,
        bus,
        phase: state.phase,
        kind: writeTo === SPEC_FILE ? 'spec' : writeTo === PLAN_FILE ? 'plan' : 'task-briefs',
        text: result.text,
        metadata,
      });
    } else {
      writeSpecFile({ projectDir, sessionId }, writeTo, result.text, metadata);
    }
  }
  return { state, text: result.text };
}
