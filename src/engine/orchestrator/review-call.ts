import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Reviewer } from '../reviewers/types.js';
import type { EventBus } from '../events/types.js';
import { writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { REVIEW_FILE } from '../../core/paths.js';
import { createBusTextHandler } from './events.js';
import { addUsageAndSave } from './state-ops.js';

export type RunReviewerCallOptions = {
  reviewer: Reviewer;
  prompt: string;
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  metadata?: SpecMetadata | null | undefined;
  signal?: AbortSignal | undefined;
};

export type RunReviewerCallResult = {
  state: WorkflowState;
  text: string;
};

export async function runReviewerCall(
  opts: RunReviewerCallOptions,
): Promise<RunReviewerCallResult> {
  const { reviewer, prompt, projectDir, sessionId, bus, metadata } = opts;
  const result = await reviewer.review(prompt, projectDir, {
    onOutput: createBusTextHandler({ bus, phase: opts.state.phase }, { content: 'markdown' }),
    signal: opts.signal,
  });
  const state = addUsageAndSave(
    { projectDir, sessionId, bus },
    opts.state,
    'reviewer',
    result.usage,
  );
  writeSpecFile({ projectDir, sessionId }, REVIEW_FILE, result.text, metadata);
  return { state, text: result.text };
}
