import { useState } from 'react';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { continueRun } from '../../../engine/orchestrator/run/continue.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import { rereadRunAtRest, resumeParkedRun } from '../handlers.js';
import { hydrateResume, resumeFailureMessage } from '../resume-hydration.js';
import { clearSessionScopedStores } from '../session-stores.js';
import type { UseInputModeResult } from './use-input-mode.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';

/** The state the next entry into the engine starts from, and what the operator typed to continue it. */
export interface InlineResume {
  prepared: PreparedExecution;
  state: WorkflowState;
  /** What the operator typed to continue this run; the engine seeds it into the first step. */
  steer?: UserMessageInput | undefined;
}

interface UseRunContinueOptions {
  prepared?: PreparedExecution | undefined;
  inputMode: UseInputModeResult;
}

export interface UseRunContinueResult {
  /** Bumped once per re-entry; the run loop's effect keys on it. */
  runId: number;
  inlineResume: InlineResume | undefined;
  /** Record the state this run carries without re-entering the engine. */
  setInlineResume: (next: InlineResume) => void;
  handleResume: (message?: UserMessageInput) => void;
}

/**
 * How a run is re-entered: the state and steer its next turn starts from, and the
 * one continuation path — a park this process holds settles in place, a run at
 * rest is re-entered on its saved state, and the operator's words ride the steer
 * into the first step's own prompt.
 */
export function useRunContinue({
  prepared,
  inputMode,
}: UseRunContinueOptions): UseRunContinueResult {
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<InlineResume | undefined>(undefined);

  const restart = (next: InlineResume) => {
    setInlineResume(next);
    setRunId((id) => id + 1);
  };

  const handleResume = (message?: UserMessageInput) => {
    if (prepared === undefined) return;
    const outcome = continueRun({
      ref: prepared.session.ref,
      ...(message !== undefined && { steer: message }),
      deps: {
        resumeParked: resumeParkedRun,
        loadState: hydrateResume,
        restart: ({ state, steer }) => {
          restart({ prepared, state, ...(steer !== undefined && { steer }) });
        },
      },
    });
    if (outcome.kind !== 'refused') return;
    inputMode.resetMode();
    // A run closed or finished elsewhere keeps its transcript and shows as it stands now.
    if (outcome.reason === 'closed' || outcome.reason === 'ready-to-apply') {
      rereadRunAtRest(prepared.session.ref);
      feedbackStore.setError(outcome.message);
      return;
    }
    clearSessionScopedStores();
    feedbackStore.setError(
      outcome.reason === 'invalid'
        ? resumeFailureMessage({ kind: 'invalid', code: 'malformed', message: outcome.message })
        : `${outcome.message} Press esc to return home.`,
    );
  };

  return { runId, inlineResume, setInlineResume, handleResume };
}
