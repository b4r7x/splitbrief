import type { PlannerCallbacksContext, WorkflowContext } from '../types.js';

export function plannerCallbacksContextOf(wctx: WorkflowContext): PlannerCallbacksContext {
  return {
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    config: wctx.config,
    callbacks: wctx.callbacks,
    bus: wctx.bus,
    signal: wctx.signal,
    metadata: wctx.metadata,
    sinks: wctx.sinks,
    drainPendingAttachments: wctx.drainPendingAttachments,
    ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
    ...(wctx.detectedContextLength !== undefined && {
      detectedContextLength: wctx.detectedContextLength,
    }),
  };
}
