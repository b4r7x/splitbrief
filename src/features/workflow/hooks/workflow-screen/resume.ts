import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { isResumable } from '../../../../core/phases.js';
import { loadState } from '../../../../core/state/persistence.js';

export function hasLoadedResumableStateForSession({
  projectDir,
  sessionId,
  routeSessionId,
  routeResumeState,
}: {
  projectDir: string;
  sessionId: string;
  routeSessionId?: string | undefined;
  routeResumeState?: WorkflowState | undefined;
}): boolean {
  if (routeSessionId === sessionId && routeResumeState && isResumable(routeResumeState)) {
    return true;
  }

  try {
    const state = loadState({ projectDir, sessionId });
    return state ? isResumable(state) : false;
  } catch {
    return false;
  }
}

export function canResumeCancelledWorkflow(opts: {
  isAttachedClient: boolean;
  cancelled: boolean;
  projectDir: string;
  sessionId: string | undefined;
  runnerSessionId: string | undefined;
  routeSessionId: string | undefined;
  routeResumeState: WorkflowState | undefined;
}): boolean {
  const currentSessionId = opts.sessionId ?? opts.runnerSessionId;
  return (
    !opts.isAttachedClient &&
    opts.cancelled &&
    currentSessionId !== undefined &&
    hasLoadedResumableStateForSession({
      projectDir: opts.projectDir,
      sessionId: currentSessionId,
      routeSessionId: opts.routeSessionId,
      routeResumeState: opts.routeResumeState,
    })
  );
}
