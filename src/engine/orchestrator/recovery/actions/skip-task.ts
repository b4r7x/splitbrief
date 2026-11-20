import { ALL_BRIEFS_SKIPPED_NOTICE, cannotDetail } from '../../../../core/recovery/causes.js';
import { recoveryFactString } from '../../../../core/schemas/recovery/facts.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { allBriefsSkipped } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { toErrorMessage } from '../../../../utils/format/errors.js';
import { publishInfo, publishWarning } from '../../publish/notice.js';
import { publishRecoveryResolved } from '../../publish/recovery.js';
import { assertProjectNotMoved, retentionError } from '../../isolation/retention.js';
import { runCodeDir } from '../../kept-work.js';
import { closeRunIfOpen } from '../../run/close.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { skipHaltedBrief } from '../../task/skip-brief.js';
import {
  currentRecoveryTask,
  blockRecoveryAction,
  recordRecoverySkipEvidence,
  markRecoveryApplying,
} from './shared.js';
import type { ApplyRecoveryActionOptions, ApplyRecoveryActionResult } from './types.js';

export async function applySkipCurrentTaskRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): Promise<ApplyRecoveryActionResult> {
  // A previous pass can record the skip and stop before it closes the run.
  if (
    issue.status === 'applying' &&
    issue.selectedAction === 'skip-current-task' &&
    allBriefsSkipped(opts.state.tasks)
  ) {
    return settleSkip(opts, issue, opts.state);
  }

  const target = currentRecoveryTask(opts.state, issue);
  if (!target) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message:
        'Skip current task requires the pending recovery task to match the current task index.',
      publishSelected: true,
    });
  }

  // The Skip works in the run's recorded workspace, so a moved project is refused before a write.
  try {
    await assertProjectNotMoved(opts, opts.state.workspace);
  } catch (err) {
    if (!retentionError.isMoved(err)) throw err;
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'isolation-project-moved',
      message: err.message,
      publishSelected: true,
    });
  }

  // A brief the planner cannot do is skipped for the planner's reason, so the transcript and the
  // review read why.
  const cannot = recoveryFactString(issue.facts, 'cannot');
  const cannotBy = recoveryFactString(issue.facts, 'cannotBy');
  const reason =
    cannot === undefined || cannotBy === undefined ? issue.message : cannotDetail(cannotBy, cannot);
  try {
    recordRecoverySkipEvidence({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      state: opts.state,
      task: target,
      reason,
    });
  } catch (err) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'skip-evidence-failed',
      message: `Failed to record skip evidence: ${toErrorMessage(err)}`,
      publishSelected: true,
    });
  }

  const applying = markRecoveryApplying(opts, issue);
  // A halt that kept the brief's files left them for a Continue or a Try again; skipping the
  // brief takes them back.
  const skipped = await skipHaltedBrief({
    wctx: {
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      bus: opts.bus,
      workspaceDir: runCodeDir(opts.projectDir, opts.state.workspace),
    },
    state: applying,
    task: target,
    reason,
    taskStartSnapshot: opts.state.changedFilesBaseline?.activeTaskSnapshot,
    expectedRevision: applying.stateRevision ?? 0,
  });
  return settleSkip(opts, issue, skipped.state, skipped.restoreWarning);
}

async function settleSkip(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
  skipped: WorkflowState,
  restoreWarning?: string,
): Promise<ApplyRecoveryActionResult> {
  const resolved = (state: WorkflowState) => {
    publishRecoveryResolved({
      bus: opts.bus,
      phase: state.phase,
      issue,
      action: opts.action,
      outcome: 'skipped-current-task',
    });
  };
  const closure = allBriefsSkipped(skipped.tasks)
    ? await closeRunIfOpen({ ...opts, onClosed: resolved }, skipped)
    : undefined;
  const state =
    closure?.state ??
    transitionAndSave(
      opts,
      skipped,
      { type: 'RESOLVE_PENDING_RECOVERY' },
      { expectedRevision: skipped.stateRevision ?? 0 },
    );
  if (closure === undefined) resolved(state);
  if (restoreWarning !== undefined) {
    publishWarning({ bus: opts.bus, phase: state.phase, message: restoreWarning });
  }
  if (closure?.closedNow) {
    publishInfo({
      bus: opts.bus,
      phase: state.phase,
      message: ALL_BRIEFS_SKIPPED_NOTICE,
    });
  }

  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: closure === undefined ? 'skipped-current-task' : 'closed',
  };
}
