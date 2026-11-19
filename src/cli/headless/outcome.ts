import { recoveryActionLabel } from '../../core/recovery/action-label.js';
import { cannotDetail, reviewFailedCause, reviewName } from '../../core/recovery/causes.js';
import { haltOf, recoveryHaltLabel } from '../../core/recovery/halt.js';
import { formatResetAt } from '../../core/recovery/reset-clock.js';
import {
  continueRunCommand,
  formatResumeCommand,
  continuesHeadless,
} from '../../core/recovery/resume-command.js';
import { recoveryFactString } from '../../core/schemas/recovery/facts.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import { sessionStatusWord } from '../../core/sessions/display.js';
import { readSession } from '../../core/sessions/io.js';
import { isAnsweredApplyRecovery, deriveRunStatus } from '../../core/sessions/run/status.js';
import { questionLine } from '../../core/state/planning-conversation.js';
import { writeHeadlessJsonRecord } from '../../engine/events/public-json.js';
import { cliError } from '../errors.js';
import { applyCommand, discardCommand, readyToApplyMessage } from '../sessions/resolve.js';

/**
 * `--plain` owns the same stdout, so the NDJSON records below are written only
 * for the JSON rendering. Every one of them is followed by a thrown `cliError`,
 * whose message carries the same fact to stderr in both modes.
 */
type RecordWriter = typeof writeHeadlessJsonRecord;

const NO_RECORD: RecordWriter = () => undefined;

export function recordWriterFor(plain: boolean): RecordWriter {
  return plain ? NO_RECORD : writeHeadlessJsonRecord;
}

export function emitRecoveryAndFailIfPending({
  state,
  sessionId,
  reviewNone,
  writeRecord,
}: {
  state: WorkflowState | null;
  sessionId: string;
  /** REVIEW None in the config the next pass runs on: the line names the row the panel shows. */
  reviewNone: boolean;
  writeRecord: RecordWriter;
}): void {
  const conversation = state?.pendingPlannerConversation;
  if (
    conversation !== undefined &&
    !conversation.answered &&
    state?.pendingRecovery === undefined
  ) {
    const resumeCommand = continueRunCommand(sessionId);
    const message = conversation.text.trim() || conversation.questions.map(questionLine).join('\n');
    writeRecord(
      {
        type: 'input_required',
        sessionId,
        call: conversation.call,
        message,
        questions: conversation.questions,
        resumeCommand,
      },
      process.stdout,
    );
    throw cliError(`The planner needs your reply.\n${message}\nContinue with: ${resumeCommand}`, 1);
  }
  const issue = state?.pendingRecovery;
  if (!issue || isAnsweredApplyRecovery(issue)) return;
  const resumeCommand = formatResumeCommand(sessionId, issue, reviewNone);
  // A seat-down halt is self-contained for a machine consumer: the finer cause,
  // the tool's own words, the request id, the reset and the declared fallback.
  const cause = recoveryFactString(issue.facts, 'cause');
  const providerMessage = recoveryFactString(issue.facts, 'providerMessage');
  const requestId = recoveryFactString(issue.facts, 'requestId');
  const fallback = recoveryFactString(issue.facts, 'fallback');
  const question = recoveryFactString(issue.facts, 'question');
  const cannot = recoveryFactString(issue.facts, 'cannot');
  const cannotBy = recoveryFactString(issue.facts, 'cannotBy');
  writeRecord(
    {
      type: 'recovery_required',
      sessionId,
      halt: haltOf(issue.reason),
      reason: issue.reason,
      status: issue.status,
      message: issue.message,
      taskId: issue.taskId,
      files: issue.files,
      affectedTaskIds: issue.affectedTaskIds,
      availableActions: issue.availableActions,
      recommendedAction: issue.recommendedAction,
      resumeCommand,
      ...(cause !== undefined && { cause }),
      ...(providerMessage !== undefined && { providerMessage }),
      ...(requestId !== undefined && { requestId }),
      ...(issue.resetAt !== undefined && { resetAt: issue.resetAt }),
      ...(fallback !== undefined && { fallback }),
      ...(question !== undefined && { question }),
      ...(cannot !== undefined && { cannot }),
    },
    process.stdout,
  );
  // The stored message names no clock; a quota halt's reset is spelled when the line is printed.
  const reset = formatResetAt(issue.resetAt);
  const diagnostic =
    issue.reason === 'review-failed' && cause === 'non-zero-exit' ? issue.details[0] : undefined;
  // Accept as is also runs with no panel, so a halt that offers it names that command too.
  const accept = issue.availableActions.includes('accept-as-is')
    ? `\n${recoveryActionLabel('accept-as-is', issue)}: ${continueRunCommand(sessionId)} --action accept-as-is [--plain|--json]`
    : '';
  throw cliError(
    `${recoveryHaltLabel(haltOf(issue.reason))} (${issue.reason}): ${issue.message}${reset === undefined ? '' : ` (${reset})`}${diagnostic === undefined ? '' : `\n${diagnostic}`}${question === undefined ? '' : `\nQuestion: ${question}`}${cannot === undefined || cannotBy === undefined ? '' : `\n${cannotDetail(cannotBy, cannot)}`}\nRecommended: ${issue.recommendedAction}\nContinue with: ${resumeCommand}${continuesHeadless(issue) ? ' [--plain|--json]' : ''}${accept}`,
    1,
  );
}

/**
 * A run with a reviewed result in its workspace is ready to apply, whether the review passed or the
 * operator accepted it as is: that is a finished headless run, not a failed review.
 */
export function emitReadyToApply(
  state: WorkflowState | null,
  sessionId: string,
  writeRecord: RecordWriter,
): boolean {
  if (state === null) return false;
  const status = deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false });
  if (status.kind !== 'ready-to-apply') return false;
  writeRecord(
    {
      type: 'ready_to_apply',
      sessionId,
      override: status.override,
      applyCommand: applyCommand(sessionId, state),
      discardCommand: discardCommand(sessionId),
    },
    process.stdout,
  );
  process.stderr.write(`${readyToApplyMessage(sessionId, state)}\n`);
  return true;
}

export function failIfFinalReviewFailed(
  state: WorkflowState | null,
  projectDir: string,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  if (state?.reviewStatus !== 'failed') return;
  const blocking = readSession({ projectDir, sessionId })?.summary?.review?.critical ?? 0;
  const accepted = state.acceptedAsIs;
  writeRecord({
    type: 'final_review_failed',
    sessionId,
    blocking,
    ...(accepted !== undefined && {
      accepted: {
        by: accepted.by ?? 'user',
        ...(accepted.note !== undefined && { note: accepted.note }),
        ...(accepted.redChecks !== undefined && { redChecks: accepted.redChecks }),
      },
    }),
  });
  throw cliError(
    `${reviewFailedCause(reviewName({ scope: 'final' }), blocking)}; see review.md`,
    1,
  );
}

export function failIfFinalReviewIncomplete(
  state: WorkflowState | null,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  if (state?.phase !== 'final-review') return;
  writeRecord({ type: 'final_review_incomplete', sessionId });
  throw cliError('Final review did not pass — workflow is incomplete.', 1);
}

/**
 * `cause` is the last error the run published under `--plain`, where no NDJSON
 * record carries it; it is printed here, once, so the pointer below is true.
 */
export function failIfSessionFailed(
  state: WorkflowState | null,
  sessionId: string,
  writeRecord: RecordWriter,
  cause: string | undefined,
): void {
  if (state === null) return;
  const status = deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false });
  if (status.kind !== 'open' || status.stop.on.kind !== 'failed') return;
  writeRecord({
    type: 'error',
    message: `Session ${sessionId} failed.`,
  });
  if (cause !== undefined) process.stderr.write(`${cause}\n`);
  throw cliError('Workflow failed — see the error output above.', 1);
}

// A run stopped short of completion — a tiered approval refused headlessly, a gate
// that ended the task loop, an operator ending the run — saves the session open or
// ended, without a pendingRecovery and without a failed stop reason, so the guards
// above miss it. A user-requested abort never reaches here: the signal check in
// runHeadless returns first, with the signal's own exit code.
export function failIfSessionInterrupted(
  projectDir: string,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  const session = readSession({ projectDir, sessionId });
  if (session === null || session.status === 'complete') return;
  writeRecord({
    type: 'error',
    message: `Session ${sessionId} did not complete (status: ${sessionStatusWord(session)}).`,
  });
  throw cliError(
    session.status === 'ended'
      ? 'Workflow was cancelled.'
      : 'Workflow did not complete — the run stopped early.',
    1,
  );
}
