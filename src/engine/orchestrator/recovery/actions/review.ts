import { queuedUserMessage } from '../../../../core/queue/state.js';
import { acceptedOpen } from '../../../../core/review/accepted.js';
import { readReviewRecord, writeAcceptedReview } from '../../../../core/review/store.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { publishRecoveryResolved } from '../../publish/recovery.js';
import type { StateStep } from '../../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../../state-ops/head.js';
import { recordUserMessage } from '../../transcript/user-message.js';
import { saveRecoveryAnswer, reviewIsNone } from './shared.js';
import type { ApplyRecoveryActionOptions, ApplyRecoveryActionResult } from './types.js';

/**
 * The operator's correction rides the message queue, which is where every other
 * mid-run instruction to the planner goes; the next planner turn drains it. An
 * empty comment is still a decision — the halt resolves and the step re-runs.
 */
export function applyReviseRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  if (issue.reason === 'review-failed') return applyReviewCorrectionAction(opts, issue);
  let state: WorkflowState;
  let correctionRecorded = false;
  const comment = opts.comment;
  if (comment !== undefined && comment.text.trim() !== '') {
    const queuedMessage = queuedUserMessage(comment, issue.phase);
    state = saveRecoveryAnswer(opts, issue, [{ type: 'ENQUEUE_USER_MSG', message: queuedMessage }]);
    recordUserMessage({ ...opts, phase: issue.phase }, comment, { queuedMessage });
    correctionRecorded = true;
  } else {
    state = saveRecoveryAnswer(opts, issue, []);
  }
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return { ok: true, action: opts.action, issue, state, status: 'continued', correctionRecorded };
}

/**
 * Records what your accept leaves open and resolves the recovery halt. On a failed review these
 * are its open findings and each red check that still blocks, and `review.md` names the accept. A
 * review too large to send judged nothing: its accept records the halt and leaves `review.md`.
 */
export function applyAcceptAsIsRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const note = opts.comment?.displayText.trim() ?? '';
  const tooLarge = issue.reason === 'review-input-too-large';
  const review = tooLarge ? null : (opts.state.review ?? readReviewRecord(ref));
  // Read before the save: ACCEPT_AS_IS clears the pending inputs that name the red checks. A run
  // stored before reviews were recorded holds no review; its Apply re-check failures stay open.
  const open =
    review !== null
      ? acceptedOpen(review, opts.state)
      : {
          findings: tooLarge ? [issue.message] : (opts.state.applyReview?.failures ?? []),
          redChecks: [],
        };
  // A scheduled task review is skipped on its own: the run stays implementing,
  // the note is recorded and the pending marker clears so the next brief starts.
  // The final review has no such marker and its accept-as-is closes the run.
  const scheduledTaskReview = tooLarge && opts.state.phase === 'implementing';
  const reviewSteps: StateStep[] = scheduledTaskReview
    ? [{ type: 'CLEAR_SCHEDULED_REVIEW' }]
    : tooLarge
      ? [{ type: 'REVIEW_DONE', reviewStatus: 'failed' }]
      : [];
  const state = saveRecoveryAnswer(opts, issue, [
    ...reviewSteps,
    { type: 'ACCEPT_AS_IS', ...open, ...(note !== '' && { note }) },
  ]);
  if (review !== null) {
    writeAcceptedReview(ref, opts.state, review, {
      redChecks: open.redChecks,
      ...(note !== '' && { note }),
    });
  }
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: 'continued',
    correctionRecorded: false,
  };
}

/**
 * A failed final review sent back with the operator's words: the correction is queued as a
 * pending input and the run moves back to final-review, where the reviewer judges
 * the candidate again with that input and without running the gates.
 */
export function applyReviewCorrectionAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  // REVIEW None runs no review that reads a note, so the words stay the steer of the next brief.
  const comment = reviewIsNone(opts) ? undefined : opts.comment;
  const correction = comment?.text ?? '';
  let state = saveRecoveryAnswer(opts, issue, [{ type: 'REVIEW_CORRECTION', text: correction }]);
  let correctionRecorded = false;
  if (comment !== undefined && correction.trim() !== '') {
    recordUserMessage({ ...ref, bus: opts.bus, phase: opts.state.phase }, comment);
    correctionRecorded = true;
    state = rebaseOnPersistedWorkflowState(ref, state);
  }
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return { ok: true, action: opts.action, issue, state, status: 'continued', correctionRecorded };
}
