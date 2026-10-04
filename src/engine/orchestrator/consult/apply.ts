import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Plan, TaskSpec } from '../../../core/schemas/plan.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { CheckResult, Task } from '../../../core/schemas/task.js';
import type {
  ChangedFilesSnapshot,
  PlannerConversation,
  WorkflowState,
} from '../../../core/schemas/workflow.js';
import { insertTasks } from '../../../core/state/task-insert.js';
import { error } from '../../../utils/error.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { EventBus } from '../../events/types.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { publishChecksRun, publishTaskReplaced, publishTasksInserted } from '../events.js';
import { waitForPlannerReply } from '../planning/call-loop.js';
import { transitionAndSave } from '../state-ops.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import { restoreAttemptFiles } from '../task/rollback.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import { formatValidationError } from '../validation/format-error.js';
import type { ValidationResult } from '../validation/result.js';
import { runChecks, type CheckRunResult } from '../validation/run-checks.js';
import type { ValidationCommandRunner, Validator } from '../validation/types.js';

export type ConsultApplyContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  validator: Validator;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  /** The state the applied answer runs on; every transition it saves is persisted. */
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  changedFiles?: readonly string[] | undefined;
  runCommand?: ValidationCommandRunner | undefined;
  /** Receives the state after each saved transition: the replacement, the inserted tasks. */
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}>;

type RewriteAction = ConsultAnswer['answer'] & { action: 'rewrite-task' };
type SplitAction = ConsultAnswer['answer'] & { action: 'split-task' };
type VerifyAction = ConsultAnswer['answer'] & { action: 'verify' };
type AskUserAction = ConsultAnswer['answer'] & { action: 'ask-user' };

/** What the answer did, with the task or tasks it left behind. */
export type ConsultApplyOutcome =
  | Readonly<{ action: 'guidance'; instructions: string; context: string | null }>
  | Readonly<{ action: 'rewrite-task'; task: Task }>
  | Readonly<{ action: 'split-task'; tasks: Task[] }>
  | Readonly<{ action: 'completed'; task: Task }>
  | Readonly<{
      action: 'ask-user';
      question: string;
      whyOnlyUserCanAnswer: string;
      choices: string[] | null;
      default: string | null;
    }>
  | Readonly<{ action: 'failed'; reason: string }>;

const consultApplyError = {
  taskMissing: (id: Task['id']) =>
    error('consult-apply-task-missing', `Task ${id} left the run before its answer applied`, {
      id,
    }),
} as const;

function sameCriteria(task: Task, spec: TaskSpec): boolean {
  const before = new Set(task.criteria ?? []);
  const after = new Set(spec.criteria);
  if (before.size !== after.size) return false;
  for (const criterion of before) {
    if (!after.has(criterion)) return false;
  }
  return true;
}

function droppedCriteria(task: Task, specs: readonly TaskSpec[]): string[] {
  const kept = new Set(specs.flatMap((spec) => spec.criteria));
  return (task.criteria ?? []).filter((criterion) => !kept.has(criterion));
}

/** The planner's brief-breaking answer, or null when the replacement keeps the task's contract. */
function guardViolation(task: Task, action: RewriteAction | SplitAction): string | null {
  if (action.action === 'rewrite-task') {
    if (action.task.id !== task.id) {
      return `the rewritten task changes its id to ${action.task.id}`;
    }
    if (!sameCriteria(task, action.task)) return 'the rewritten task changes its criteria';
    return null;
  }
  if (task.parentId !== undefined) {
    return `${task.id} is already a subtask of a split and cannot be split again`;
  }
  const dropped = droppedCriteria(task, action.tasks);
  if (dropped.length > 0) {
    return `the subtasks together drop ${dropped.join(', ')}`;
  }
  return null;
}

function guardAskUser(
  task: Task,
  action: RewriteAction | SplitAction,
  reason: string,
): ConsultApplyOutcome {
  const specs = action.action === 'rewrite-task' ? [action.task] : action.tasks;
  const dropped = droppedCriteria(task, specs);
  const droppedText = dropped.length > 0 ? dropped.join(', ') : 'none';
  return {
    action: 'ask-user',
    question: `SPLITBRIEF asked the planner to fix ${task.id}, but ${reason}. Dropped criteria: ${droppedText}. How should ${task.id} proceed?`,
    whyOnlyUserCanAnswer: `The planner's answer cannot keep every criterion of ${task.id}, and only you can decide how to cover them.`,
    choices: null,
    default: null,
  };
}

/**
 * Rewrites the task in place; `attempt` is the current attempt's start snapshot, or
 * null when no attempt ran and there is nothing to roll back.
 */
async function applyRewrite(
  ctx: ConsultApplyContext,
  task: Task,
  action: RewriteAction,
  attempt: ChangedFilesSnapshot | null,
): Promise<ConsultApplyOutcome> {
  if (attempt !== null) {
    await restoreAttemptFiles({ wctx: ctx, phase: ctx.state.phase, attemptSnapshot: attempt });
  }
  const state = transitionAndSave(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    ctx.state,
    {
      type: 'REPLACE_TASK',
      taskId: task.id,
      task: taskFromSpec(action.task, ctx.workspaceDir),
    },
  );
  ctx.onStateChange?.(state);
  const replaced = state.tasks.find((candidate) => candidate.id === task.id);
  if (replaced === undefined) throw consultApplyError.taskMissing(task.id);
  publishTaskReplaced({ bus: ctx.bus, phase: state.phase }, replaced.id, replaced.revision ?? 1);
  return { action: 'rewrite-task', task: replaced };
}

async function applySplit(
  ctx: ConsultApplyContext,
  task: Task,
  action: SplitAction,
  attempt: ChangedFilesSnapshot | null,
): Promise<ConsultApplyOutcome> {
  if (attempt !== null) {
    await restoreAttemptFiles({ wctx: ctx, phase: ctx.state.phase, attemptSnapshot: attempt });
  }
  const inserted = insertTasks(action.tasks, ctx.state.tasks, (spec) =>
    taskFromSpec(spec, ctx.workspaceDir),
  );
  const state = transitionAndSave(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    ctx.state,
    { type: 'INSERT_TASKS', parentId: task.id, tasks: inserted },
  );
  ctx.onStateChange?.(state);
  const tasks = inserted.map(
    (child) => state.tasks.find((candidate) => candidate.id === child.id) ?? child,
  );
  publishTasksInserted(
    { bus: ctx.bus, phase: state.phase },
    task.id,
    tasks.map((child) => child.id),
  );
  return { action: 'split-task', tasks };
}

const ASK_USER_QUESTION_ID = 'ask-user';

function criteriaCheckIds(task: Task, plan: Plan | undefined): string[] {
  const served = new Set(task.criteria ?? []);
  const checkIds = new Set<string>();
  for (const criterion of plan?.criteria ?? []) {
    if (!served.has(criterion.id)) continue;
    for (const checkId of criterion.checkIds) checkIds.add(checkId);
  }
  return [...checkIds];
}

function verifySelectionError(
  task: Task,
  plan: Plan | undefined,
  checkIds: readonly string[],
): string | null {
  if (checkIds.length === 0) return 'the verify selection names no check';
  const known = new Set([
    ...(task.checks ?? []).map((check) => check.id),
    ...(plan?.checks ?? []).map((check) => check.id),
  ]);
  const unknown = checkIds.filter((checkId) => !known.has(checkId));
  if (unknown.length > 0) return `the verify selection names unknown checks: ${unknown.join(', ')}`;
  const missing = criteriaCheckIds(task, plan).filter((checkId) => !checkIds.includes(checkId));
  if (missing.length > 0) {
    return `the verify selection misses the task's criteria checks: ${missing.join(', ')}`;
  }
  return null;
}

function verifyFailures(
  validationResults: ValidationResult[],
  acceptance: ValidationAcceptance,
  checkRuns: readonly CheckRunResult[],
): string[] {
  const failures: string[] = [];
  if (!acceptance.accepted) failures.push(formatValidationError(validationResults, acceptance));
  for (const run of checkRuns) {
    if (run.status === 'pass') continue;
    failures.push(`check ${run.checkId} did not pass (${run.status}): ${run.output}`);
  }
  return failures;
}

async function applyVerify(
  ctx: ConsultApplyContext,
  task: Task,
  action: VerifyAction,
): Promise<ConsultApplyOutcome> {
  const plan = ctx.state.plan;
  const selectionError = verifySelectionError(task, plan, action.checkIds);
  if (selectionError !== null) return { action: 'failed', reason: selectionError };

  const changedFiles = ctx.changedFiles ?? [];
  const validationResults = await ctx.validator.runValidation({
    task,
    projectDir: ctx.workspaceDir,
    config: ctx.config,
    bus: ctx.bus,
    phase: ctx.state.phase,
    discoveredValidation: ctx.state.discoveredValidation,
    signal: ctx.signal,
    changedFiles,
  });
  const acceptance = ctx.validator.decideAcceptance({ results: validationResults, changedFiles });
  const checkRuns = await runChecks(action.checkIds, {
    task,
    plan,
    projectDir: ctx.workspaceDir,
    config: ctx.config,
    bus: ctx.bus,
    phase: ctx.state.phase,
    planApproved: true,
    discoveredValidation: ctx.state.discoveredValidation,
    signal: ctx.signal,
    ...(ctx.runCommand !== undefined && { runCommand: ctx.runCommand }),
  });
  const checkResults: CheckResult[] = checkRuns.map((run) => ({
    id: run.checkId,
    passed: run.status === 'pass',
  }));
  const recorded = transitionAndSave(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    ctx.state,
    { type: 'RECORD_CHECK_RESULTS', taskId: task.id, results: checkResults },
  );
  ctx.onStateChange?.(recorded);
  publishChecksRun({ bus: ctx.bus, phase: recorded.phase }, task.id, checkResults);

  const failures = verifyFailures(validationResults, acceptance, checkRuns);
  if (failures.length > 0) return { action: 'failed', reason: failures.join('\n\n') };

  const commit = await validateCommitAndAdvance({
    task,
    acceptance,
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    config: ctx.config,
    bus: ctx.bus,
    state: recorded,
    method: 'consulted',
    transitionType: 'VALIDATION_PASS',
    taskChangedFiles: [...changedFiles],
  });
  if (!commit.completed) {
    return { action: 'failed', reason: `the ${task.id} completion did not commit` };
  }
  ctx.onStateChange?.(commit.state);
  const completed = commit.state.tasks.find((candidate) => candidate.id === task.id) ?? task;
  return { action: 'completed', task: completed };
}

function askUserQuestion(action: AskUserAction): ClarificationQuestion {
  if (action.choices !== null && action.choices.length > 0) {
    return {
      id: ASK_USER_QUESTION_ID,
      type: 'choice',
      text: action.question,
      options: action.choices,
      ...(action.default !== null && { default: action.default }),
    };
  }
  return {
    id: ASK_USER_QUESTION_ID,
    type: 'input',
    text: action.question,
    ...(action.default !== null && { default: action.default }),
  };
}

function defaultAnswer(question: ClarificationQuestion): string {
  if (typeof question.default === 'boolean') return question.default ? 'Yes' : 'No';
  return question.default ?? '';
}

function replyAnswer(
  question: ClarificationQuestion,
  reply: string | PlannerReplyAnswer | undefined,
): string {
  if (reply === undefined) return defaultAnswer(question);
  if (typeof reply === 'string') return reply.trim() === '' ? defaultAnswer(question) : reply;
  return reply.text.trim() === '' ? defaultAnswer(question) : reply.text;
}

async function applyAskUser(
  ctx: ConsultApplyContext,
  action: AskUserAction,
): Promise<ConsultApplyOutcome> {
  const question = askUserQuestion(action);
  const asked: PlannerConversation = {
    call: 'plan',
    text: action.question,
    questions: [question],
    answers: [],
    answered: false,
  };
  const reply = await waitForPlannerReply(ctx, asked);
  return { action: 'guidance', instructions: replyAnswer(question, reply), context: null };
}

/**
 * Moves the run on the planner's answer: guidance hands back what the next attempt's error
 * block carries; a rewrite or a split rolls the current attempt back and replaces the task;
 * verify completes the task when its selection covers the criteria and the validation and
 * checks pass; ask-user puts the planner's one question to the operator and hands the answer
 * back as guidance; an answer that would drop a criterion or split a subtask becomes ask-user.
 *
 * `attempt` is the current attempt's start snapshot; null means no attempt ran (a stale
 * refresh before dispatch), so there is nothing to roll back.
 */
export async function applyConsultAnswer(
  ctx: ConsultApplyContext,
  task: Task,
  answer: ConsultAnswer,
  attempt: ChangedFilesSnapshot | null,
): Promise<ConsultApplyOutcome> {
  const action = answer.answer;
  if (action.action === 'rewrite-task' || action.action === 'split-task') {
    const violation = guardViolation(task, action);
    if (violation !== null) return guardAskUser(task, action, violation);
  }
  switch (action.action) {
    case 'guidance':
      return { action: 'guidance', instructions: action.instructions, context: action.context };
    case 'rewrite-task':
      return applyRewrite(ctx, task, action, attempt);
    case 'split-task':
      return applySplit(ctx, task, action, attempt);
    case 'verify':
      return applyVerify(ctx, task, action);
    case 'ask-user':
      return applyAskUser(ctx, action);
    default:
      return assertNever(action);
  }
}
