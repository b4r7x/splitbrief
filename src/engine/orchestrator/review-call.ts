import type { z } from 'zod';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Reviewer } from '../reviewers/types.js';
import type { EventBus } from '../events/types.js';
import { requestTyped, type RequestTypedResult } from '../runners/typed-output.js';
import { createBusTextHandler } from './events.js';
import { addUsageAndSave } from './state-ops.js';

export type RunReviewerCallOptions<T> = {
  reviewer: Reviewer;
  prompt: string;
  /** The answer contract: the verdict with its coverage refinement, or the plan call's answer. */
  schema: z.ZodType<T>;
  jsonSchema: Readonly<Record<string, unknown>>;
  schemaName: string;
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  /** The render images the reviewer takes, when its seat accepts them. */
  images?: readonly Attachment[] | undefined;
  signal?: AbortSignal | undefined;
};

export type RunReviewerCallResult<T> = {
  state: WorkflowState;
  result: RequestTypedResult<T>;
};

/**
 * A review call: a typed request through the reviewer seat, with the seat's
 * own one-repair contract, and the usage it spent booked against the reviewer
 * bucket whichever way it landed.
 */
export async function runReviewerCall<T>(
  opts: RunReviewerCallOptions<T>,
): Promise<RunReviewerCallResult<T>> {
  const { reviewer, prompt, projectDir, workspaceDir, sessionId, bus } = opts;
  const call = reviewer.typedCall({
    projectDir: workspaceDir,
    seat: 'reviewer',
    callbacks: {
      onOutput: createBusTextHandler({ bus, phase: opts.state.phase }, { content: 'markdown' }),
      signal: opts.signal,
    },
    ...(opts.images !== undefined && { images: [...opts.images] }),
  });
  const result = await requestTyped({
    prompt,
    schema: opts.schema,
    jsonSchema: opts.jsonSchema,
    schemaName: opts.schemaName,
    call,
  });
  const state = addUsageAndSave(
    { projectDir, sessionId, bus },
    opts.state,
    'reviewer',
    result.usage,
  );
  return { state, result };
}
