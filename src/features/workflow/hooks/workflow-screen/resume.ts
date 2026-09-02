import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { isResumable } from '../../../../core/phases.js';
import { loadStateForResume } from '../../../../core/state/resume-authority.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../../../core/state/types.js';

export type WorkflowScreenResumeResult =
  | { kind: 'resumable'; state: WorkflowState }
  | { kind: 'storage-blocked'; state: WorkflowState }
  | { kind: 'not-resumable'; reason: 'missing' | 'terminal' | 'other-phase' }
  | { kind: 'invalid'; code: 'malformed' | 'future-version'; message: string };

type ResumeAuthorityInput = StateAuthorityReceipt | ResumeLoadAuthority;

function fencedAuthority(
  receipt: StateAuthorityReceipt,
): Extract<ResumeLoadAuthority, { kind: 'fenced' }> {
  return { kind: 'fenced', receipt, promotedFromVersion: null };
}

function resumeAuthority(input: ResumeAuthorityInput): ResumeLoadAuthority {
  return input.kind === 'usable' ? fencedAuthority(input) : input;
}

function classifyLoadedState(state: WorkflowState): WorkflowScreenResumeResult {
  if (!isResumable(state)) {
    return {
      kind: 'not-resumable',
      reason: state.phase === 'idle' || state.phase === 'complete' ? 'terminal' : 'other-phase',
    };
  }
  return state.briefRecovery?.status === 'storage-blocked'
    ? { kind: 'storage-blocked', state }
    : { kind: 'resumable', state };
}

export function loadWorkflowScreenResume(opts: {
  projectDir: string;
  sessionId: string;
  authority?: ResumeAuthorityInput | undefined;
  routeSessionId?: string | undefined;
  routeResumeState?: WorkflowState | undefined;
}): WorkflowScreenResumeResult {
  if (opts.routeSessionId === opts.sessionId && opts.routeResumeState !== undefined) {
    return classifyLoadedState(opts.routeResumeState);
  }
  if (opts.authority === undefined) return { kind: 'not-resumable', reason: 'missing' };

  try {
    const result = loadStateForResume({
      ref: { projectDir: opts.projectDir, sessionId: opts.sessionId },
      authority: resumeAuthority(opts.authority),
    });
    if (result.kind === 'missing') return { kind: 'not-resumable', reason: 'missing' };
    if (result.kind === 'invalid') return result;
    return classifyLoadedState(result.state);
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
  authority,
}: {
  projectDir: string;
  sessionId: string;
  authority?: ResumeAuthorityInput | undefined;
  routeSessionId?: string | undefined;
  routeResumeState?: WorkflowState | undefined;
}): boolean {
  const result = loadWorkflowScreenResume({
    projectDir,
    sessionId,
    authority,
    routeSessionId,
    routeResumeState,
  });
  return result.kind === 'resumable' || result.kind === 'storage-blocked';
}

export function canResumeCancelledWorkflow(opts: {
  isAttachedClient: boolean;
  cancelled: boolean;
  projectDir: string;
  sessionId: string | undefined;
  runnerSessionId: string | undefined;
  authority?: ResumeAuthorityInput | undefined;
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
      authority: opts.authority,
      routeSessionId: opts.routeSessionId,
      routeResumeState: opts.routeResumeState,
    })
  );
}
