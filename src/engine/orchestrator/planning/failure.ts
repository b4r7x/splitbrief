import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlanningPhaseResult } from './types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError } from '../events.js';
import {
  raisePendingRecovery,
  rebaseOnPersistedWorkflowState,
  transitionAndSave,
} from '../state-ops.js';
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
import { artifactPresence } from '../../../core/sessions/run-record-io.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import {
  buildPlannerCallFailedRecoveryIssue,
  type PlannerSeatFailure,
} from '../recovery/builders/planner.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { labelError } from '../../../utils/format-errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { nowIso } from '../../../utils/format-time.js';

export async function handlePlanningFailure(opts: {
  err: unknown;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  wctx: PlannerCallbacksContext;
}): Promise<Extract<PlanningPhaseResult, { disposition: 'terminal' }>> {
  const { err, projectDir, sessionId, state, wctx } = opts;
  const ref = { projectDir, sessionId };
  const latest = rebaseOnPersistedWorkflowState(ref, state);

  // A user abort is not a failure: the step it cut is recorded so the run picks
  // up there, and the run stays open.
  if (isAbortError(err)) {
    return {
      disposition: 'terminal',
      state: transitionAndSave(ref, latest, {
        type: 'INTERRUPT_STEP',
        step: resumeStep(latest, artifactPresence(ref)),
        source: 'user',
        cut: 'mid-step',
      }),
      outcome: 'interrupted',
    };
  }

  // A failed planner call keeps the tool's own diagnosis in typed error data;
  // "Planner planner call failed" alone hides an expired login entirely.
  const typed = typedRunnerCallErrorMessage(err);
  let message = labelError('Planning failed', err);
  if (typed !== null && !message.includes(typed)) {
    message = `${message} — ${sanitizeTerminalDiagnosticText(typed)}`;
  }
  const displayName = runnerAuthDisplayName(wctx.config.planner);
  // A limit outranks the auth check: its message must never earn login
  // advice, because logging in does not restore quota. API planners throw
  // their provider errors, so the raw 429 detail is read from typed data.
  const limitDetail =
    usageLimitDetailFromError(err) ??
    (isUsageLimitDiagnostic(typed ?? message) ? (typed ?? message) : null);
  const resetsAt = limitDetail === null ? null : parseUsageLimitReset(limitDetail);
  let failure: PlannerSeatFailure = 'call-failed';
  if (limitDetail !== null) {
    failure = 'usage-limit';
    message = `${message}. ${displayName} hit its usage limit — logging in again will not fix this. ${usageLimitWaitClause(resetsAt)} or switch the planner, then start again.`;
  } else if (isAuthFailureDiagnostic(typed ?? message)) {
    failure = 'unauthenticated';
    message = `${message}. ${runnerLoginInstruction(wctx.config.planner)}`;
  }
  publishError({ bus: wctx.bus, phase: latest.phase, message });

  const seatSwap = await loadSeatSwapContext({
    projectDir,
    seat: 'plan',
    runner: wctx.config.planner,
  });
  const issue = buildPlannerCallFailedRecoveryIssue({
    failure,
    phase: latest.phase,
    message,
    details: typed === null ? [] : [`${displayName} reported: ${typed}`],
    tool: displayName,
    ...(resetsAt !== null && { resetAt: resetsAt.toISOString() }),
    ...(seatSwap !== undefined && { seatSwap }),
    createdAt: nowIso(),
  });

  return {
    disposition: 'terminal',
    state: raisePendingRecovery({ ...ref, bus: wctx.bus }, latest, issue),
    outcome: 'halted',
  };
}
