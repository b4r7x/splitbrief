import type { PlannerCallbacksContext, WorkflowContext } from '../types.js';

export function plannerCallbacksContextOf(wctx: WorkflowContext): PlannerCallbacksContext {
  return {
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    config: wctx.config,
    callbacks: wctx.callbacks,
    bus: wctx.bus,
    steering: wctx.steering,
    signal: wctx.signal,
    metadata: wctx.metadata,
    sinks: wctx.sinks,
    drainPendingAttachments: wctx.drainPendingAttachments,
    ...(wctx.resumeHolder !== undefined && { resumeHolder: wctx.resumeHolder }),
    ...(wctx.plannerContext !== undefined && { plannerContext: wctx.plannerContext }),
    ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
    ...(wctx.detectedContextLength !== undefined && {
      detectedContextLength: wctx.detectedContextLength,
    }),
    ...(wctx.continuation !== undefined && { continuation: wctx.continuation }),
    ...(wctx.context.skillsContext !== undefined && {
      skillsContext: wctx.context.skillsContext,
    }),
  };
}

/** The request the planner reads: the run's feature and the `@file` context it carries. */
export function plannerFeature(feature: string, plannerContext: string | undefined): string {
  return plannerContext
    ? `${feature}\n\n<user-context>\n${plannerContext}\n</user-context>`
    : feature;
}
