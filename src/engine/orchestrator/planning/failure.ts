import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlanningPhaseResult } from './types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError } from '../events.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { loadStateForResume } from '../../../core/state/persistence.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../../core/state/types.js';
import { typedRunnerCallErrorMessage } from '../../implementers/pipeline/call-result.js';
import {
  isAuthFailureDiagnostic,
  runnerAuthDisplayName,
  runnerLoginInstruction,
} from '../../runners/auth-failure.js';
import {
  isUsageLimitDiagnostic,
  parseUsageLimitReset,
  usageLimitDetailFromError,
  usageLimitWaitClause,
} from '../../runners/usage-limit.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { labelError } from '../../../utils/format-errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { workflowAuthority } from '../run/init.js';

function loadPersistedRewindState(opts: {
  projectDir: string;
  sessionId: string;
  authority: StateAuthorityReceipt | undefined;
}): WorkflowState | null {
  if (opts.authority === undefined) return null;
  const authority: ResumeLoadAuthority = {
    kind: 'fenced',
    receipt: opts.authority,
    promotedFromVersion: null,
  };
  const result = loadStateForResume({
    ref: { projectDir: opts.projectDir, sessionId: opts.sessionId },
    authority,
  });
  return result.kind === 'loaded' && result.state.rewindPending !== undefined ? result.state : null;
}

export function handlePlanningFailure(opts: {
  err: unknown;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  wctx: PlannerCallbacksContext;
}): PlanningPhaseResult {
  const { err, projectDir, sessionId, state, wctx } = opts;
  // A failed planner call keeps the tool's own diagnosis in typed error data;
  // "Planner planner call failed" alone hides an expired login entirely.
  const typed = typedRunnerCallErrorMessage(err);
  let message = labelError('Planning failed', err);
  if (typed !== null && !message.includes(typed)) {
    message = `${message} — ${sanitizeTerminalDiagnosticText(typed)}`;
  }
  // A limit outranks the auth check: its message must never earn login
  // advice, because logging in does not restore quota. API planners throw
  // their provider errors, so the raw 429 detail is read from typed data.
  const limitDetail =
    usageLimitDetailFromError(err) ??
    (isUsageLimitDiagnostic(typed ?? message) ? (typed ?? message) : null);
  if (limitDetail !== null) {
    const resetsAt = parseUsageLimitReset(limitDetail);
    message = `${message}. ${runnerAuthDisplayName(wctx.config.planner)} hit its usage limit — logging in again will not fix this. ${usageLimitWaitClause(resetsAt)} or switch the planner, then resume.`;
  } else if (isAuthFailureDiagnostic(typed ?? message)) {
    message = `${message}. ${runnerLoginInstruction(wctx.config.planner)}`;
  }
  if (!isAbortError(err)) {
    publishError({ bus: wctx.bus, phase: state.phase, message });
  }
  if (isAbortError(err)) {
    const persisted = loadPersistedRewindState({
      projectDir,
      sessionId,
      authority: workflowAuthority(wctx),
    });
    if (persisted !== null) {
      return {
        disposition: 'terminal',
        state: persisted,
        outcome: 'cancelled',
      };
    }
  }
  const latest = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state);
  return {
    disposition: 'terminal',
    state: transitionAndSave({ projectDir, sessionId }, latest, { type: 'CANCEL' }),
    outcome: isAbortError(err) ? 'cancelled' : 'failed',
  };
}
