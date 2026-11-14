import type { z } from 'zod';
import { requireReviewSeat } from '../../../core/config/accessors/reviewer-runner.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { EventBus } from '../../events/types.js';
import {
  requestTyped,
  typedPromptSuffix,
  type RequestTypedResult,
} from '../../runners/typed-output.js';
import { addUsageAndSave } from '../state-ops/usage.js';
import { publishSeatAnswerRefused } from '../publish/seat.js';
import type { SteeringPort } from '../../calls/steering.js';
import { runThrowingSeatCall } from '../escalation/seat/call.js';

type ReviewerCallInput = Readonly<{
  prompt: string;
  images?: readonly Attachment[] | undefined;
}>;

/**
 * An input built again for each attempt. The prompt is completed once the seat's binding is
 * known, with the text the call appends after it, such as the answer schema a seat without
 * native typed output reads.
 */
type PreparedReviewerCallInput = Readonly<{
  prompt: (suffix: string) => string;
  images?: readonly Attachment[] | undefined;
}>;

export type RunReviewerCallOptions<T> = {
  reviewer: Pick<Reviewer, 'typedCall'>;
  /** The answer contract: the verdict with its coverage refinement, or the plan call's answer. */
  schema: z.ZodType<T>;
  jsonSchema: Readonly<Record<string, unknown>>;
  schemaName: string;
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  /** The run config: its REVIEW seat is the runner a limit waits on or falls back from. */
  config: Config;
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  steering?: SteeringPort | undefined;
} & (ReviewerCallInput | { prepareCall: () => Promise<PreparedReviewerCallInput> });

export type RunReviewerCallResult<T> = {
  state: WorkflowState;
  result: RequestTypedResult<T>;
};

/**
 * A review call: a typed request through the reviewer seat under the REVIEW seat's trouble
 * ladder (`runSeatCall`), with the seat's own one-repair contract, and the usage it spent
 * booked against the reviewer bucket whichever way it landed.
 */
export async function runReviewerCall<T>(
  opts: RunReviewerCallOptions<T>,
): Promise<RunReviewerCallResult<T>> {
  const { reviewer, projectDir, workspaceDir, sessionId, bus, config } = opts;
  const ref = { projectDir, sessionId, bus };
  let current = opts.state;
  const result = await runThrowingSeatCall(
    {
      ref,
      state: current,
      seat: 'review',
      runner: requireReviewSeat(config).runner,
      config,
      ...(opts.signal !== undefined && { signal: opts.signal }),
      onStateChange: (next) => {
        current = next;
      },
    },
    (signal) =>
      requestTyped({
        prepareCall: async () => {
          const input = 'prepareCall' in opts ? await opts.prepareCall() : opts;
          const call = reviewer.typedCall({
            projectDir: workspaceDir,
            seat: 'reviewer',
            callbacks: {
              onOutput: () => {},
              signal,
              ...(opts.steering !== undefined && { steering: opts.steering }),
            },
            ...(input.images !== undefined &&
              input.images.length > 0 && { images: [...input.images] }),
          });
          return {
            prompt:
              typeof input.prompt === 'string'
                ? input.prompt
                : input.prompt(typedPromptSuffix(call.typedOutput, opts.jsonSchema)),
            call,
          };
        },
        schema: opts.schema,
        jsonSchema: opts.jsonSchema,
        schemaName: opts.schemaName,
        onRepair: (reasons) =>
          publishSeatAnswerRefused({ bus, phase: current.phase }, 'reviewer', reasons),
      }),
  );
  const state = addUsageAndSave(ref, current, 'reviewer', result.usage);
  return { state, result };
}
