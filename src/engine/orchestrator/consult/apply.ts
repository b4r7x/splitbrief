import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { Plan, TaskSpec } from '../../../core/schemas/plan.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import { error } from '../../../utils/error.js';
import { assertNever } from '../../../utils/type-guards.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import { runBriefGate } from '../task/gates/brief.js';
import { criteriaCheckIds } from './answer-contract.js';
import type {
  RewriteAction,
  SplitAction,
  ConsultApplyContext,
  ConsultApplyOutcome,
  VerifyAction,
} from './types.js';
import { applyRewrite, applySplit } from './rewrite.js';
import { applyAskUser } from './ask-user.js';

function droppedCriteria(task: Task, specs: readonly TaskSpec[]): string[] {
  const kept = new Set(specs.flatMap((spec) => spec.criteria));
  return (task.criteria ?? []).filter((criterion) => !kept.has(criterion));
}

function droppedCriteriaChecks(
  task: Task,
  plan: Plan | undefined,
  specs: readonly TaskSpec[],
): string[] {
  const carried = new Set((task.checks ?? []).map((check) => check.id));
  const kept = new Set(specs.flatMap((spec) => spec.checks.map((check) => check.id)));
  return criteriaCheckIds(task.criteria ?? [], plan).filter(
    (checkId) => carried.has(checkId) && !kept.has(checkId),
  );
}

/** The planner's brief-breaking answer, or null when the replacement keeps the task's contract. */
function guardViolation(
  task: Task,
  plan: Plan | undefined,
  action: RewriteAction | SplitAction,
): string | null {
  const criteriaText = (ids: readonly string[]) =>
    ids
      .map((id) => {
        const text = plan?.criteria.find((criterion) => criterion.id === id)?.text;
        return text ? `${id} (“${text}”)` : id;
      })
      .join(', ');
  if (action.action === 'rewrite-task') {
    const dropped = droppedCriteria(task, [action.task]);
    const original = new Set(task.criteria ?? []);
    const added = action.task.criteria.filter((criterion) => !original.has(criterion));
    if (dropped.length > 0 && added.length > 0) {
      return `the rewritten brief changes its criteria: drops ${criteriaText(dropped)} and adds ${criteriaText(added)}`;
    }
    if (dropped.length > 0) {
      return `the rewritten brief changes its criteria: drops ${criteriaText(dropped)}`;
    }
    if (added.length > 0) {
      return `the rewritten brief changes its criteria: adds ${criteriaText(added)}`;
    }
    const droppedChecks = droppedCriteriaChecks(task, plan, [action.task]);
    if (droppedChecks.length > 0) {
      return `the rewritten brief drops the checks its criteria require: ${droppedChecks.join(', ')}`;
    }
    return null;
  }
  const dropped = droppedCriteria(task, action.tasks);
  if (dropped.length > 0) {
    return `the new briefs together drop ${criteriaText(dropped)}`;
  }
  const droppedChecks = droppedCriteriaChecks(task, plan, action.tasks);
  if (droppedChecks.length > 0) {
    return `the new briefs together drop the checks their criteria require: ${droppedChecks.join(', ')}`;
  }
  return null;
}

async function applyGuardQuestion(
  ctx: ConsultApplyContext,
  input: { task: Task; action: RewriteAction | SplitAction; reason: string },
): Promise<ConsultApplyOutcome> {
  const { task, action, reason } = input;
  return applyAskUser(ctx, task, {
    action: 'ask-user',
    diagnosis: action.diagnosis,
    question: `SPLITBRIEF asked the planner to fix ${task.id}, but ${reason}. How should ${task.id} proceed?`,
    whyOnlyUserCanAnswer: `The planner's answer cannot keep every criterion of ${task.id}, and only you can decide how to cover them.`,
    choices: null,
    default: null,
  });
}

async function applyVerify(
  ctx: ConsultApplyContext,
  task: Task,
  action: VerifyAction,
  attempt: ChangedFilesSnapshot,
): Promise<ConsultApplyOutcome> {
  const changedFiles = ctx.changedFiles ?? [];
  const gated = await runBriefGate({
    wctx: ctx,
    task,
    state: ctx.state,
    changedFiles,
    taskStartSnapshot: attempt,
    checkIds: action.checkIds,
    runCommand: ctx.runCommand,
    setTrackedState: ctx.onStateChange,
  });
  if (gated.stop === 'skipped') return { action: 'skipped' };
  if (gated.correction) return { action: 'correction', answer: gated.error };
  const { acceptance } = gated;
  if (gated.stop !== undefined || !acceptance.accepted)
    return {
      action: 'failed',
      reason: gated.error || 'the brief gate stopped',
    };

  const commit = await validateCommitAndAdvance({
    task,
    acceptance,
    projectDir: ctx.projectDir,
    workspaceDir: ctx.workspaceDir,
    sessionId: ctx.sessionId,
    taskStartSnapshot: ctx.taskStartSnapshot,
    config: ctx.config,
    bus: ctx.bus,
    state: gated.state,
    method: 'consulted',
    transitionType: 'VALIDATION_PASS',
    taskChangedFiles: [...changedFiles],
  });
  if (!commit.completed) {
    return { action: 'failed', reason: `the ${task.id} completion did not commit` };
  }
  ctx.onStateChange?.(commit.state);
  const completed = commit.state.tasks.find((candidate) => candidate.id === task.id) ?? task;
  return {
    action: 'completed',
    task: completed,
    durationMs: commit.durationMs,
    bookedFiles: commit.bookedFiles,
  };
}

/**
 * Moves the run on the planner's consult answer: guidance hands back what the next attempt's error
 * block carries; a rewrite or a split replaces the task and keeps the failed attempt's files;
 * verify completes the task when the validation and the checks it names pass, and a
 * pre_validation deny of that gate skips the task; ask-user puts the planner's
 * one question to the operator and hands the answer back as guidance, or hands back the question
 * when nobody answers it; cannot hands back the planner's reason; an answer that would drop a criterion or one of its checks asks the
 * operator through that same path.
 *
 * `attempt` is the current attempt's start snapshot.
 */
export async function applyConsultAnswer(
  ctx: ConsultApplyContext,
  task: Task,
  answer: ConsultAnswer,
  attempt: ChangedFilesSnapshot,
): Promise<ConsultApplyOutcome> {
  const action = answer.answer;
  if (action.action === 'rewrite-task' || action.action === 'split-task') {
    const violation = guardViolation(task, ctx.state.plan, action);
    if (violation !== null) return applyGuardQuestion(ctx, { task, action, reason: violation });
  }
  switch (action.action) {
    case 'guidance':
      return { action: 'guidance', instructions: action.instructions, context: action.context };
    case 'rewrite-task':
      return applyRewrite(ctx, task, action);
    case 'split-task':
      return applySplit(ctx, task, action);
    case 'verify':
      return applyVerify(ctx, task, action, attempt);
    case 'ask-user':
      return applyAskUser(ctx, task, action);
    case 'cannot':
      return { action: 'cannot', reason: action.reason, next: action.next };
    case 'accept':
      throw error('consult-accept', 'Only a stuck review takes an accept answer.');
    default:
      return assertNever(action);
  }
}
