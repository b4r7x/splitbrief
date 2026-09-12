import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { isResumable } from '../../../../core/phases.js';
import { loadOwnerWorkflowState } from '../../../../core/state/resume-hydration.js';

export type WorkflowScreenResumeResult =
  | { kind: 'resumable'; state: WorkflowState }
  | { kind: 'not-resumable'; reason: 'missing' | 'terminal' | 'other-phase' }
  | { kind: 'invalid'; code: 'malformed' | 'future-version'; message: string };

function classifyLoadedState(state: WorkflowState): WorkflowScreenResumeResult {
  if (!isResumable(state)) {
    return {
      kind: 'not-resumable',
      reason: state.phase === 'idle' || state.phase === 'complete' ? 'terminal' : 'other-phase',
    };
  }
  return { kind: 'resumable', state };
}

export function loadWorkflowScreenResume(opts: {
  projectDir: string;
  sessionId: string;
  routeSessionId?: string | undefined;
  routeResumeState?: WorkflowState | undefined;
}): WorkflowScreenResumeResult {
  if (opts.routeSessionId === opts.sessionId && opts.routeResumeState !== undefined) {
    return classifyLoadedState(opts.routeResumeState);
  }

  try {
    const owned = loadOwnerWorkflowState({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
    });
    if (owned.kind === 'missing') return { kind: 'not-resumable', reason: 'missing' };
    if (owned.kind === 'invalid') return owned;
    return classifyLoadedState(owned.state);
  } catch (error) {
    return {
      kind: 'invalid',
      code: 'malformed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

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
  const result = loadWorkflowScreenResume({
    projectDir,
    sessionId,
    routeSessionId,
    routeResumeState,
  });
  return result.kind === 'resumable';
}

export function canResumeCancelledWorkflow(opts: {
  cancelled: boolean;
  projectDir: string;
  sessionId: string | undefined;
  runnerSessionId: string | undefined;
  routeSessionId: string | undefined;
  routeResumeState: WorkflowState | undefined;
}): boolean {
  const currentSessionId = opts.sessionId ?? opts.runnerSessionId;
  return (
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
