import type { z } from 'zod';
import { requireReviewSeat } from '../../../core/config/accessors/reviewer-runner.js';
import { phaseStage } from '../../../core/phases/rail.js';
import { isQueuedMessagePendingReviewer } from '../../../core/queue/state.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  type ReviewAnswer,
  REVIEW_ANSWER_JSON_SCHEMA,
} from '../../../core/schemas/review/verdict.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { Reviewer } from '../../planners/reviewer.js';
import type { EventBus } from '../../events/types.js';
import {
  requestTyped,
  typedPromptSuffix,
  type RequestTypedResult,
  type SeatProtocolError,
} from '../../runners/typed-output.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';
import type { ContinuationSeed } from '../continuation/holder.js';
import { withContinuationLoop } from '../continuation/loop.js';
import { settleMidCallDeliveries } from '../queue/mid-call.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { publishSeatAnswerRefused } from '../publish/seat.js';
import type { SteeringPort } from '../../calls/steering.js';
import { runThrowingSeatCall } from '../escalation/seat/call.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { PreparedReviewerCallInput, ReviewStatePort } from './types.js';

type ReviewerCallInput = Readonly<{
  prompt: string;
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
 * ladder (`runSeatCall`), with the seat's own one-repair contract.
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
  return { state: current, result };
}

/** What the review seat gave back once no message waits for it. */
export type ReviewerAnswer =
  | Readonly<{ kind: 'answered'; answer: ReviewAnswer }>
  | Readonly<{ kind: 'refused'; error: SeatProtocolError }>
  | Readonly<{ kind: 'stopped' }>;

/** The review call's fixed input: the seat, the answer contract and the ports of the phase. */
export type ReviewerCallContext = Readonly<{
  reviewer: Reviewer;
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  callbacks: OrchestratorCallbacks;
  signal: AbortSignal | undefined;
  sinks: WorkflowSinks | undefined;
  steering: SteeringPort | undefined;
  live: ReviewStatePort;
  setTrackedState: ((state: WorkflowState) => void) | undefined;
  schema: z.ZodType<ReviewAnswer>;
  step: StepRef;
  /** Builds the prompt and the images of one attempt, with the images of its steer. */
  prepareCall: (steerImages: readonly Attachment[]) => Promise<PreparedReviewerCallInput>;
}>;

type ReviewerAsk = Readonly<{
  result: RequestTypedResult<ReviewAnswer>;
  /** The continuation the next call of this review inherits. */
  seed: ContinuationSeed | undefined;
}>;

/** One review call with no sinks: the steer of the seed adds its images to each attempt. */
async function askReviewerOnce(
  ctx: ReviewerCallContext,
  seed: ContinuationSeed | undefined,
): Promise<ReviewerAsk> {
  const steerImages = seed?.steer?.images ?? [];
  const call = await runReviewerCall({
    reviewer: ctx.reviewer,
    prepareCall: () => ctx.prepareCall(steerImages),
    schema: ctx.schema,
    jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
    schemaName: 'review_answer',
    projectDir: ctx.projectDir,
    workspaceDir: ctx.workspaceDir,
    sessionId: ctx.sessionId,
    bus: ctx.bus,
    config: ctx.config,
    state: ctx.live.get(),
    signal: ctx.signal,
    ...(ctx.steering !== undefined && { steering: ctx.steering }),
  });
  ctx.live.set(call.state);
  return { result: call.result, seed };
}

/**
 * One review call under the continuation loop. The review is one shot by constitution: a
 * continuation re-issues the whole deterministic prompt — spec, briefs, diff or change file,
 * drift, evidence — with the operator's note on the end. It never resumes a session.
 */
async function askReviewerInLoop(
  ctx: ReviewerCallContext,
  seed: ContinuationSeed | undefined,
  sinks: WorkflowSinks,
): Promise<ReviewerAsk> {
  let next: ContinuationSeed | undefined;
  const loop = await withContinuationLoop<RequestTypedResult<ReviewAnswer>>({
    ctx: {
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      callbacks: ctx.callbacks,
      bus: ctx.bus,
      signal: ctx.signal,
      sinks,
    },
    state: ctx.live.get(),
    step: ctx.step,
    ...(seed === undefined ? {} : { seed }),
    onStateChange: ctx.live.set,
    body: async ({ signal: callSignal, partial, steer, steerInput }) => {
      next = steerInput === undefined ? undefined : { steer: steerInput };
      const call = await runReviewerCall({
        reviewer: ctx.reviewer,
        prepareCall: async () => {
          const prepared = await ctx.prepareCall(steerInput?.images ?? []);
          return {
            prompt: (suffix) =>
              partial === undefined && steer === undefined
                ? prepared.prompt(suffix)
                : composeContinuation({ basePrompt: prepared.prompt(suffix), partial, steer }),
            images: prepared.images,
          };
        },
        schema: ctx.schema,
        jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
        schemaName: 'review_answer',
        projectDir: ctx.projectDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: ctx.sessionId,
        bus: ctx.bus,
        config: ctx.config,
        state: ctx.live.get(),
        signal: callSignal,
        ...(ctx.steering !== undefined && { steering: ctx.steering }),
      });
      ctx.live.set(call.state);
      return call.result;
    },
  });
  return { result: loop.value, seed: next };
}

/**
 * The review call, asked again while a message waits for the reviewer. After each call the
 * deliveries it made settle and the state rebases on the saved one; a stop, a refused answer or
 * an answer with no message left waiting ends it.
 */
export async function callReviewer(
  ctx: ReviewerCallContext,
  seed: ContinuationSeed | undefined,
): Promise<ReviewerAnswer> {
  let current = seed;
  while (true) {
    const asked =
      ctx.sinks === undefined
        ? await askReviewerOnce(ctx, current)
        : await askReviewerInLoop(ctx, current, ctx.sinks);
    current = asked.seed;
    const ref = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
    await settleMidCallDeliveries(ref);
    const state = rebaseOnPersistedWorkflowState(ref, ctx.live.get(), { keepUnsaved: true });
    ctx.live.set(state);
    ctx.setTrackedState?.(state);
    if (ctx.signal?.aborted) return { kind: 'stopped' };
    if ('error' in asked.result) return { kind: 'refused', error: asked.result.error };
    const messagePendingReviewer =
      phaseStage(state.phase) === 'review' &&
      state.messageQueue.some(isQueuedMessagePendingReviewer);
    if (!messagePendingReviewer) return { kind: 'answered', answer: asked.result.value };
  }
}
