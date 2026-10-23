import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import type { OwnedResumeState } from '../../../core/state/resume-hydration.js';
import { deriveRunStatus, type RunStatus } from '../../../core/sessions/run-status.js';
import { recoveryActionLabel } from '../../../core/recovery/action-label.js';
import { statusLeavesWordsUnread } from '../../../core/recovery/typed-words.js';
import { sanitizePasteBody } from '../../../lib/terminal/filtered-stdin/paste.js';

export type ContinueRunOutcome =
  /** A park this process was holding settled; the run carried on where it stood. */
  | { kind: 'continued-in-place' }
  /** The run was at rest and was re-entered on its saved state. */
  | { kind: 'restarted'; state: WorkflowState }
  | {
      kind: 'refused';
      reason: 'missing' | 'invalid' | 'closed' | 'ready-to-apply' | 'takes-no-words';
      message: string;
    };

const CLOSED_MESSAGE: Record<Extract<RunStatus, { kind: 'closed' }>['as'], string> = {
  complete: 'Cannot continue: this run is complete; start a new one.',
  ended: 'Cannot continue: this run was ended; start a new one.',
  applied: 'Cannot continue: this run was applied; start a new one.',
  undone: 'Cannot continue: the Apply of this run was undone; start a new one.',
  discarded: 'Cannot continue: this run was discarded; start a new one.',
};

export type ContinueRunDeps = Readonly<{
  /**
   * Settles a park this process is holding, with the operator's steer. True when
   * there was one; false when the run is at rest and has to be re-entered.
   */
  resumeParked: (steer: UserMessageInput) => boolean;
  /** Reads the owner's saved state. */
  loadState: (ref: SessionRef) => OwnedResumeState;
  /**
   * Re-enters the run on this state. The steer rides `RunWorkflowOptions.steer`,
   * where it seeds the first step's continuation.
   */
  restart: (input: { state: WorkflowState; steer: UserMessageInput | undefined }) => void;
}>;

/**
 * The one way a run is continued. A run this process is still holding resumes
 * through its park; a run at rest is re-entered on its saved state. Either way
 * the operator's words travel as a steer the next step composes into its own
 * prompt — never as a message queued behind the run — and they are also
 * recorded as the user message they are, in the transcript and session log.
 */
export function continueRun(
  input: Readonly<{ ref: SessionRef; steer?: UserMessageInput | undefined; deps: ContinueRunDeps }>,
): ContinueRunOutcome {
  const { ref, deps } = input;
  const displayText = sanitizePasteBody(input.steer?.displayText ?? '').trim();
  const steer: UserMessageInput =
    input.steer === undefined
      ? plainUserMessage('')
      : {
          ...input.steer,
          text: displayText + input.steer.text.slice(input.steer.displayText.length),
          displayText,
        };

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
        'Cannot continue: this run is ready to apply; choose Apply or Discard (/run accept, /run reject confirm).',
    };
  }

  // Typed words no step would read wait for a bare ⏎.
  if (steer.text !== '' && statusLeavesWordsUnread(status)) {
    return { kind: 'refused', reason: 'takes-no-words', message: noWordsMessage(status) };
  }

  deps.restart({ state: hydrated.state, steer: steer.text === '' ? undefined : steer });
  return { kind: 'restarted', state: hydrated.state };
}

function noWordsMessage(status: RunStatus): string {
  if (status.kind !== 'open' || status.stop.on.kind !== 'halt') {
    return 'Cannot send words to Apply. Clear them.';
  }
  const issue = status.stop.on.issue;
  const chosen = issue.status === 'applying' ? issue.selectedAction : undefined;
  return chosen === undefined
    ? 'Cannot send words to this halt. Clear them first.'
    : `Cannot send words with ${recoveryActionLabel(chosen, { reason: issue.reason })}. Clear them.`;
}
