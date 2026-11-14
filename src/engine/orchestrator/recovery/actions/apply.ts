import { decidedRecovery } from '../../../../core/recovery/decide.js';
import { allowedActionsForHalt, haltOf } from '../../../../core/recovery/halt.js';
import type { Config } from '../../../../core/schemas/config.js';
import { recoveryFactString } from '../../../../core/schemas/recovery/facts.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { UserMessageInput } from '../../../../core/types/user-input.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { haltCutApply } from '../../apply/halt.js';
import { recordDecideForMe } from '../../planning/call-loop.js';
import { endRun } from '../../run/end.js';
import { recordBriefCorrection } from '../../state-ops/corrections.js';
import { applyRetryLaterRecoveryAction } from './retry.js';
import { applyRetrySameWorkerRecoveryAction } from './retry.js';
import { applySwitchSeatRecoveryAction } from './switch-seat.js';
import { applySkipCurrentTaskRecoveryAction } from './skip-task.js';
import {
  applyReviseRecoveryAction,
  applyAcceptAsIsRecoveryAction,
  applyReviewCorrectionAction,
} from './review.js';
import { applyContinueRecoveryAction } from './continue.js';
import { blockRecoveryAction, markRecoveryApplying } from './shared.js';
import type { ApplyRecoveryActionOptions, ApplyRecoveryActionResult } from './types.js';

export async function applyRecoveryAction(
  input: ApplyRecoveryActionOptions,
): Promise<ApplyRecoveryActionResult> {
  const { applying } = input.state;
  // An Apply cut off by a crash is halted, though no process lived to record it: the action answers
  // that halt as it answers the one a later re-entry would raise.
  const opts =
    input.state.pendingRecovery === undefined && applying !== undefined
      ? { ...input, state: await haltCutApply(input, input.state, applying.backupId) }
      : input;
  const issue = opts.state.pendingRecovery;
  if (!issue) {
    return {
      ok: false,
      action: opts.action,
      state: opts.state,
      status: 'blocked',
      code: 'no-pending-recovery',
      message: 'No pending recovery issue is available.',
    };
  }

  if (opts.action === 'end-run') {
    const closure = await endRun(opts, opts.state);
    return { ok: true, action: opts.action, issue, state: closure.state, status: 'closed' };
  }

  if (opts.action === 'decide-for-me') return applyDecideForMeRecoveryAction(opts, issue);

  if (!issue.availableActions.includes(opts.action)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" is not available for ${issue.reason}.`,
    });
  }

  if (opts.action === 'continue') {
    return applyContinueRecoveryAction(opts, issue);
  }

  if (!allowedActionsForHalt(haltOf(issue.reason)).includes(opts.action)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" is not allowed for ${issue.reason}.`,
    });
  }

  switch (opts.action) {
    case 'revise':
      return applyReviseRecoveryAction(opts, issue);
    case 'accept-as-is':
      return applyAcceptAsIsRecoveryAction(opts, issue);
    case 'skip-current-task':
      return applySkipCurrentTaskRecoveryAction(opts, issue);
    case 'restore-backup': {
      const state = markRecoveryApplying(opts, issue);
      return {
        ok: true,
        action: opts.action,
        issue,
        state,
        status: 'continued',
        correctionRecorded: false,
      };
    }
    case 'retry-same-worker': {
      if (issue.reason === 'apply-partial') {
        const state = markRecoveryApplying(opts, issue);
        return {
          ok: true,
          action: opts.action,
          issue,
          state,
          status: 'continued',
          correctionRecorded: false,
        };
      }
      // A review that failed only on renders its seat could not see runs again as a correction
      // with no note: the closed review reopens and judges the same candidate on the seat the
      // picker holds.
      if (issue.reason === 'review-failed' && issue.facts?.reviewSeatNoImages === true) {
        return applyReviewCorrectionAction(opts, issue);
      }
      return applyRetrySameWorkerRecoveryAction(opts, issue);
    }
    case 'switch-seat':
      return applySwitchSeatRecoveryAction(opts);
    case 'retry-later':
      return applyRetryLaterRecoveryAction(opts, issue);
    default:
      return assertNever(opts.action);
  }
}

/**
 * Decide for me: the run records the choice, then takes the step it takes by itself from now
 * on. A halt that offers the row takes it; after the choice, every halt with a decided step does.
 */
async function applyDecideForMeRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): Promise<ApplyRecoveryActionResult> {
  const decided = decidedRecovery(issue);
  if (
    decided === undefined ||
    (!issue.availableActions.includes('decide-for-me') && opts.state.decideForMe !== true)
  ) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "decide-for-me" is not available for ${issue.reason}.`,
    });
  }
  let state = recordDecideForMe(opts, opts.state);
  const question = recoveryFactString(issue.facts, 'question');
  if (decided.answer !== undefined && question !== undefined && issue.taskId !== undefined) {
    state = recordBriefCorrection(
      opts,
      state,
      issue.taskId,
      `Question: ${question}\nAnswer: ${decided.answer}`,
    );
  }
  return applyRecoveryAction({ ...opts, state, action: decided.action });
}

/**
 * After Decide for me, a halt with a decided step takes it with no one asked: the TUI and a
 * headless continue both take it here. Words the user typed to continue answer the halt instead,
 * as they do without the choice. Undefined, in the same tick, when the halt waits on the user.
 */
export function applyDecidedRecovery(
  opts: Omit<ApplyRecoveryActionOptions, 'action' | 'candidate' | 'comment' | 'entryConfig'>,
  entryConfig: () => Config,
  typed: UserMessageInput | undefined,
): Promise<ApplyRecoveryActionResult> | undefined {
  const issue = opts.state.pendingRecovery;
  if (opts.state.decideForMe !== true || issue === undefined) return undefined;
  const decided = decidedRecovery(issue);
  if (decided === undefined || (typed?.text.trim() ?? '') !== '') return undefined;
  return applyRecoveryAction({
    ...opts,
    action: 'decide-for-me',
    entryConfig: entryConfig(),
  });
}
