import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Reviewer } from '../../reviewers/types.js';
import type {
  Planner,
  PlannerCallbacks,
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
  ctx: PlannerCallPublisherContext,
  event: Parameters<typeof publishRunnerCallEvent>[1],
): void {
  publishRunnerCallEvent({ bus: ctx.bus, phase: ctx.getPhase() }, event);
}

function withPlannerCallbacks(
  callbacks: PlannerCallbacks,
  ctx: PlannerCallPublisherContext,
): PlannerCallbacks {
  if (callbacks.onCallEvent !== undefined) return callbacks;
  return {
    ...callbacks,
    onCallEvent: (event) => publishPlannerRunnerCall(ctx, event),
  };
}

function withPlannerOutputCallbacks(
  callbacks: PlannerOutputCallbacks,
  ctx: PlannerCallPublisherContext,
): PlannerOutputCallbacks {
  if (callbacks.onCallEvent !== undefined) return callbacks;
  return {
    ...callbacks,
    onCallEvent: (event) => publishPlannerRunnerCall(ctx, event),
  };
}

function withPlannerCallEventCallbacks(
  callbacks: PlannerCallEventCallbacks | undefined,
  ctx: PlannerCallPublisherContext,
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
    callbacks: withPlannerCallEventCallbacks(opts?.callbacks, ctx),
  };
}

function withPlannerStructuredSummaryOptions(
  opts: PlannerStructuredSummaryOptions | undefined,
  ctx: PlannerCallPublisherContext,
): PlannerStructuredSummaryOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts?.callbacks, ctx),
  };
}

function withPlannerUserTurnOptions(
  opts: PlannerUserTurnOptions,
  ctx: PlannerCallPublisherContext,
): PlannerUserTurnOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts.callbacks, ctx),
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
    plan: (opts) =>
      planner.plan({
        ...opts,
        callbacks: withPlannerCallbacks(opts.callbacks, ctx),
      }),
    quickPlan: (opts) =>
      planner.quickPlan({
        ...opts,
        callbacks: withPlannerCallbacks(opts.callbacks, ctx),
      }),
    regenerate: (opts) =>
      planner.regenerate({
        ...opts,
        callbacks: withPlannerOutputCallbacks(opts.callbacks, ctx),
      }),
    escalateHint: (opts) =>
      planner.escalateHint({
        ...opts,
        callbacks: withPlannerOutputCallbacks(opts.callbacks, ctx),
      }),
    escalateFull: (opts) =>
      planner.escalateFull({
        ...opts,
        callbacks: withPlannerOutputCallbacks(opts.callbacks, ctx),
      }),
    review: (prompt, projectDir, callbacks) =>
      review(prompt, projectDir, withPlannerOutputCallbacks(callbacks, ctx)),
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
  return {
    review: (prompt, projectDir, callbacks) =>
      review(prompt, projectDir, withPlannerOutputCallbacks(callbacks, ctx)),
  };
}
