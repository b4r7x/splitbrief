import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { OwnedResumeState } from '../../../core/state/resume-hydration.js';
import { deriveRunStatus, type RunStatus } from '../../../core/sessions/run-status.js';
import { sanitizePasteBody } from '../../../lib/terminal/filtered-stdin/paste.js';

export type ContinueRunOutcome =
  /** A park this process was holding settled; the run carried on where it stood. */
  | { kind: 'continued-in-place' }
  /** The run was at rest and was re-entered on its saved state. */
  | { kind: 'restarted'; state: WorkflowState }
  | {
      kind: 'refused';
      reason: 'missing' | 'invalid' | 'closed' | 'ready-to-apply';
      message: string;
    };

const CLOSED_MESSAGE: Record<Extract<RunStatus, { kind: 'closed' }>['as'], string> = {
  complete: 'This run is complete; start a new one.',
  ended: 'This run was ended; start a new one.',
  applied: 'This run was applied; start a new one.',
  discarded: 'This run was discarded; start a new one.',
};

export type ContinueRunDeps = Readonly<{
  /**
   * Settles a park this process is holding, with the operator's steer. True when
   * there was one; false when the run is at rest and has to be re-entered.
   */
  resumeParked: (steer: string) => boolean;
  /** Reads the owner's saved state. */
  loadState: (ref: SessionRef) => OwnedResumeState;
  /**
   * Re-enters the run on this state. The steer rides `RunWorkflowOptions.steer`,
   * where it seeds the first step's continuation.
   */
  restart: (input: { state: WorkflowState; steer: string | undefined }) => void;
}>;

/**
 * The one way a run is continued. A run this process is still holding resumes
 * through its park; a run at rest is re-entered on its saved state. Either way
 * the operator's words travel as a steer the next step composes into its own
 * prompt — never as a message queued behind the run — and they are also
 * recorded as the user message they are, in the transcript and session log.
 */
export function continueRun(
  input: Readonly<{ ref: SessionRef; steer?: string | undefined; deps: ContinueRunDeps }>,
): ContinueRunOutcome {
  const { ref, deps } = input;
  // The steer becomes a prompt, and a seat that takes its prompt in argv (cursor, opencode) cannot
  // be spawned with a NUL in it. It keeps only what a paste may carry, whatever put it in the draft.
  const steer = sanitizePasteBody(input.steer ?? '').trim();

  if (deps.resumeParked(steer)) return { kind: 'continued-in-place' };

  const hydrated = deps.loadState(ref);
  if (hydrated.kind === 'missing') {
    return { kind: 'refused', reason: 'missing', message: 'No saved state to continue.' };
  }
  if (hydrated.kind === 'invalid') {
    return { kind: 'refused', reason: 'invalid', message: hydrated.message };
  }

  const status = deriveRunStatus({
    state: hydrated.state,
    liveness: 'not-alive',
  });
  if (status.kind === 'closed') {
    return { kind: 'refused', reason: 'closed', message: CLOSED_MESSAGE[status.as] };
  }
  if (status.kind === 'ready-to-apply') {
    return {
      kind: 'refused',
      reason: 'ready-to-apply',
      message:
        'This run is ready to apply; choose Apply or Discard (/run accept, /run reject confirm).',
    };
  }

  deps.restart({ state: hydrated.state, steer: steer === '' ? undefined : steer });
  return { kind: 'restarted', state: hydrated.state };
}
