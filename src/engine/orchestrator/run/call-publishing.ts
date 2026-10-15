import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Reviewer } from '../../reviewers/types.js';
import type {
  Planner,
  PlannerCallEventCallbacks,
  PlannerOutputCallbacks,
  PlannerStructuredSummaryOptions,
  PlannerSummaryOptions,
  PlannerUserTurnOptions,
} from '../../planners/types.js';
import { publishRunnerCallEvent } from '../events.js';
import type { WorkflowContext } from '../types.js';

export type PlannerCallPublisherContext = {
  bus: WorkflowContext['bus'];
  getPhase: () => WorkflowState['phase'];
};

function publishPlannerRunnerCall(
  ctx: PlannerCallPublisherContext & { rootDir: string },
  event: Parameters<typeof publishRunnerCallEvent>[1],
): void {
  publishRunnerCallEvent({ bus: ctx.bus, phase: ctx.getPhase(), rootDir: ctx.rootDir }, event);
}

function withPlannerOutputCallbacks(
  callbacks: PlannerOutputCallbacks,
  ctx: PlannerCallPublisherContext & { rootDir: string },
): PlannerOutputCallbacks {
  if (callbacks.onCallEvent !== undefined) return callbacks;
  return {
    ...callbacks,
    onCallEvent: (event) => publishPlannerRunnerCall(ctx, event),
  };
}

/** A typed-answer call's text is its answer, which the caller validates and records, so none of it reaches the transcript. */
function withTypedAnswerCallbacks(
  callbacks: PlannerOutputCallbacks,
  ctx: PlannerCallPublisherContext & { rootDir: string },
): PlannerOutputCallbacks {
  return { ...withPlannerOutputCallbacks(callbacks, ctx), onOutput: () => {} };
}

function withPlannerCallEventCallbacks(
  callbacks: PlannerCallEventCallbacks | undefined,
  ctx: PlannerCallPublisherContext & { rootDir: string },
): PlannerCallEventCallbacks {
  if (callbacks?.onCallEvent !== undefined) return callbacks;
  return {
    ...callbacks,
    onCallEvent: (event) => publishPlannerRunnerCall(ctx, event),
  };
}

function withPlannerSummaryOptions(
  opts: PlannerSummaryOptions | undefined,
  ctx: PlannerCallPublisherContext,
): PlannerSummaryOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts?.callbacks, {
      ...ctx,
      rootDir: opts?.projectDir ?? process.cwd(),
    }),
  };
}

function withPlannerStructuredSummaryOptions(
  opts: PlannerStructuredSummaryOptions | undefined,
  ctx: PlannerCallPublisherContext,
): PlannerStructuredSummaryOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts?.callbacks, {
      ...ctx,
      rootDir: opts?.projectDir ?? process.cwd(),
    }),
  };
}

function withPlannerUserTurnOptions(
  opts: PlannerUserTurnOptions,
  ctx: PlannerCallPublisherContext,
): PlannerUserTurnOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts.callbacks, { ...ctx, rootDir: opts.projectDir }),
  };
}

export function withPlannerCallPublishing(
  planner: Planner,
  ctx: PlannerCallPublisherContext,
): Planner {
  const review = planner.review.bind(planner);
  const wrapped: Planner = {
    isAvailable: () => planner.isAvailable(),
    getVersion: () => planner.getVersion(),
    capabilities: planner.capabilities,
    review: (prompt, projectDir, callbacks) =>
      review(
        prompt,
        projectDir,
        withPlannerOutputCallbacks(callbacks, { ...ctx, rootDir: projectDir }),
      ),
    typedCall: (typedCtx) =>
      planner.typedCall({
        ...typedCtx,
        callbacks: withTypedAnswerCallbacks(typedCtx.callbacks, {
          ...ctx,
          rootDir: typedCtx.projectDir,
        }),
      }),
    summarize: (messages, opts) =>
      planner.summarize(messages, withPlannerSummaryOptions(opts, ctx)),
  };
  const unavailabilityReason = planner.unavailabilityReason;
  if (unavailabilityReason !== undefined) {
    wrapped.unavailabilityReason = () => unavailabilityReason.call(planner);
  }
  const injectUserTurn = planner.injectUserTurn;
  if (injectUserTurn !== undefined) {
    wrapped.injectUserTurn = (opts) =>
      injectUserTurn.call(planner, withPlannerUserTurnOptions(opts, ctx));
  }
  const summarizeStructured = planner.summarizeStructured;
  if (summarizeStructured !== undefined) {
    wrapped.summarizeStructured = (messages, opts) =>
      summarizeStructured.call(planner, messages, withPlannerStructuredSummaryOptions(opts, ctx));
  }
  return wrapped;
}

export function withReviewerCallPublishing(
  reviewer: Reviewer,
  ctx: PlannerCallPublisherContext,
): Reviewer {
  const review = reviewer.review.bind(reviewer);
  const typedCall = reviewer.typedCall.bind(reviewer);
  return {
    review: (prompt, projectDir, callbacks) =>
      review(
        prompt,
        projectDir,
        withPlannerOutputCallbacks(callbacks, { ...ctx, rootDir: projectDir }),
      ),
    typedCall: (typedCtx) =>
      typedCall({
        ...typedCtx,
        callbacks: withTypedAnswerCallbacks(typedCtx.callbacks, {
          ...ctx,
          rootDir: typedCtx.projectDir,
        }),
      }),
  };
}
