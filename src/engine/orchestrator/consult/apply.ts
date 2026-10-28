import type { ConsultAnswer, ConsultSeat } from '../../../core/schemas/consult.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Plan, TaskSpec } from '../../../core/schemas/plan.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { Task } from '../../../core/schemas/task.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import { recordUserMessage } from '../transcript/user-message.js';
import type {
  ChangedFilesSnapshot,
  PlannerConversation,
  WorkflowState,
} from '../../../core/schemas/workflow.js';
import { dueCriterionIds } from '../../../core/review/verdict.js';
import { briefCorrections } from '../../../core/state/machine.js';
import { insertTasks, lineageIdOf } from '../../../core/state/task-insert.js';
import { error } from '../../../utils/error.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { EventBus } from '../../events/types.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { consultSeatRunner } from '../escalation/consult-guidance.js';
import { publishTaskReplaced, publishTasksInserted, publishTasksPlanned } from '../events.js';
import { waitForPlannerReply } from '../planning/call-loop.js';
import { recordBriefCorrection, transitionAndSave } from '../state-ops.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import { restoreAttemptFiles } from '../task/rollback.js';
import { lineageAnchorAction } from '../task/refresh-code.js';
import { runBriefGate } from '../task/brief-gate.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import { checkRegistry } from '../validation/run-checks.js';
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
  /** The seat that answered the consult, which the operator's question names. */
  seat: ConsultSeat;
  signal?: AbortSignal | undefined;
  changedFiles?: readonly string[] | undefined;
  /** Where the brief's first attempt started. */
  taskStartSnapshot: ChangedFilesSnapshot;
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
  | Readonly<{ action: 'completed'; task: Task; durationMs: number; bookedFiles: string[] }>
  | Readonly<{ action: 'correction'; answer: string }>
  | Readonly<{ action: 'failed'; reason: string }>
  | Readonly<{ action: 'skipped' }>;

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

/** The consult seat's brief-breaking answer, or null when the replacement keeps the task's contract. */
function guardViolation(
  task: Task,
  plan: Plan | undefined,
  action: RewriteAction | SplitAction,
): string | null {
  if (action.action === 'rewrite-task') {
    if (!sameCriteria(task, action.task)) return 'the rewritten task changes its criteria';
    const dropped = droppedCriteriaChecks(task, plan, [action.task]);
    if (dropped.length > 0) {
      return `the rewritten task drops the checks its criteria require: ${dropped.join(', ')}`;
    }
    return null;
  }
  const dropped = droppedCriteria(task, action.tasks);
  if (dropped.length > 0) {
    return `the subtasks together drop ${dropped.join(', ')}`;
  }
  const droppedChecks = droppedCriteriaChecks(task, plan, action.tasks);
  if (droppedChecks.length > 0) {
    return `the subtasks together drop the checks their criteria require: ${droppedChecks.join(', ')}`;
  }
  return null;
}

async function applyGuardQuestion(
  ctx: ConsultApplyContext,
  input: { task: Task; action: RewriteAction | SplitAction; reason: string },
): Promise<ConsultApplyOutcome> {
  const { task, action, reason } = input;
  const runner = consultSeatRunner(ctx.seat);
  const specs = action.action === 'rewrite-task' ? [action.task] : action.tasks;
  const dropped = droppedCriteria(task, specs);
  const droppedText = dropped.length > 0 ? dropped.join(', ') : 'none';
  return applyAskUser(ctx, task, {
    action: 'ask-user',
    diagnosis: action.diagnosis,
    question: `SPLITBRIEF asked the ${runner} to fix ${task.id}, but ${reason}. Dropped criteria: ${droppedText}. How should ${task.id} proceed?`,
    whyOnlyUserCanAnswer: `The ${runner}'s answer cannot keep every criterion of ${task.id}, and only you can decide how to cover them.`,
    choices: null,
    default: null,
  });
}

/**
 * A rewrite or a split child continues the lineage of `earlier`, the brief it replaces: a file that
 * lineage created stays `create`, though the workspace holds its output.
 */
async function continuedTask(ctx: ConsultApplyContext, task: Task, earlier: Task): Promise<Task> {
  const action = await lineageAnchorAction(
    ctx,
    ctx.state,
    lineageIdOf(earlier),
    task.suggestedFiles[0],
    ctx.workspaceDir,
  );
  return { ...task, action };
}

/** Rewrites the task in place; `attempt` is the current attempt's start snapshot. */
async function applyRewrite(
  ctx: ConsultApplyContext,
  task: Task,
  action: RewriteAction,
  attempt: ChangedFilesSnapshot,
): Promise<ConsultApplyOutcome> {
  await restoreAttemptFiles({ wctx: ctx, phase: ctx.state.phase, attemptSnapshot: attempt });
  const state = transitionAndSave(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    ctx.state,
    {
      type: 'REPLACE_TASK',
      taskId: task.id,
      task: await continuedTask(ctx, taskFromSpec(action.task, ctx.workspaceDir), task),
    },
  );
  ctx.onStateChange?.(state);
  const replaced = state.tasks.find((candidate) => candidate.id === task.id);
  if (replaced === undefined) throw consultApplyError.taskMissing(task.id);
  publishTasksPlanned({ bus: ctx.bus, phase: state.phase }, state.tasks);
  publishTaskReplaced({ bus: ctx.bus, phase: state.phase }, replaced.id, replaced.revision ?? 1);
  return { action: 'rewrite-task', task: replaced };
}

async function applySplit(
  ctx: ConsultApplyContext,
  task: Task,
  action: SplitAction,
  attempt: ChangedFilesSnapshot,
): Promise<ConsultApplyOutcome> {
  await restoreAttemptFiles({ wctx: ctx, phase: ctx.state.phase, attemptSnapshot: attempt });
  const inserted = await Promise.all(
    insertTasks(action.tasks, ctx.state.tasks, (spec) => taskFromSpec(spec, ctx.workspaceDir)).map(
      (child) => continuedTask(ctx, child, task),
    ),
  );
  const state = transitionAndSave(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    ctx.state,
    { type: 'INSERT_TASKS', parentId: task.id, tasks: inserted },
  );
  ctx.onStateChange?.(state);
  const tasks = inserted.map((child) => {
    const saved = state.tasks.find((candidate) => candidate.id === child.id);
    if (saved === undefined) throw consultApplyError.taskMissing(child.id);
    return saved;
  });
  publishTasksPlanned({ bus: ctx.bus, phase: state.phase }, state.tasks);
  publishTasksInserted(
    { bus: ctx.bus, phase: state.phase },
    task.id,
    tasks.map((child) => child.id),
  );
  return { action: 'split-task', tasks };
}

const ASK_USER_QUESTION_ID = 'ask-user';

function criteriaCheckIds(criteria: readonly string[], plan: Plan | undefined): string[] {
  const served = new Set(criteria);
  const checkIds = new Set<string>();
  for (const criterion of plan?.criteria ?? []) {
    if (!served.has(criterion.id)) continue;
    for (const checkId of criterion.checkIds) checkIds.add(checkId);
  }
  return [...checkIds];
}

function verifySelectionError(
  task: Task,
  state: WorkflowState,
  checkIds: readonly string[],
): string | null {
  if (checkIds.length === 0) return 'the verify selection names no check';
  const known = checkRegistry({ task, tasks: state.tasks, plan: state.plan });
  const unknown = checkIds.filter((checkId) => !known.has(checkId));
  if (unknown.length > 0) return `the verify selection names unknown checks: ${unknown.join(', ')}`;
  // The brief gate checks a criterion only once it is due, so a later owner's check never binds.
  const due = new Set(dueCriterionIds(state, task.id));
  const dueCriteria = (task.criteria ?? []).filter((criterionId) => due.has(criterionId));
  const missing = criteriaCheckIds(dueCriteria, state.plan).filter(
    (checkId) => !checkIds.includes(checkId),
  );
  if (missing.length > 0) {
    return `the verify selection misses the task's criteria checks: ${missing.join(', ')}`;
  }
  return null;
}

async function applyVerify(
  ctx: ConsultApplyContext,
  task: Task,
  action: VerifyAction,
  attempt: ChangedFilesSnapshot,
): Promise<ConsultApplyOutcome> {
  const selectionError = verifySelectionError(task, ctx.state, action.checkIds);
  if (selectionError !== null) return { action: 'failed', reason: selectionError };

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
    return { action: 'failed', reason: gated.error || 'the brief gate stopped' };

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
 * The question the user sees: the brief's operator instructions, then the seat's question next to
 * its choices, so the user sees which of their own instructions the question concerns.
 */
function askUserQuestion(
  action: AskUserAction,
  taskId: string,
  instructions: readonly string[],
): ClarificationQuestion {
  const text =
    instructions.length === 0
      ? action.question
      : [
          `Your instructions for ${taskId}:`,
          ...instructions.map((instruction) => `- ${instruction.replaceAll('\n', '\n  ')}`),
          '',
          action.question,
        ].join('\n');
  if (action.choices !== null && action.choices.length > 0) {
    return {
      id: ASK_USER_QUESTION_ID,
      type: 'choice',
      text,
      options: action.choices,
      ...(action.default !== null && { default: action.default }),
    };
  }
  return {
    id: ASK_USER_QUESTION_ID,
    type: 'input',
    text,
    ...(action.default !== null && { default: action.default }),
  };
}

function defaultAnswer(question: ClarificationQuestion): string {
  if (typeof question.default === 'boolean') return question.default ? 'Yes' : 'No';
  return question.default ?? '';
}

export function consultReplyAnswer(
  question: ClarificationQuestion,
  reply: UserMessageInput | PlannerReplyAnswer | undefined,
): PlannerReplyAnswer {
  const message = reply === undefined ? undefined : 'message' in reply ? reply.message : reply;
  if (message === undefined || message.text.trim() === '') {
    const text = defaultAnswer(question);
    return {
      message: plainUserMessage(text),
      qa: [{ question: question.text, answer: text }],
    };
  }
  if (reply !== undefined && 'message' in reply) return reply;
  return { message, qa: [{ question: question.text, answer: message.displayText }] };
}

/**
 * Puts the seat's question to the user. The answer joins the brief's operator instructions,
 * so every later call on the brief, build or consult, reads it with the user's corrections.
 */
async function applyAskUser(
  ctx: ConsultApplyContext,
  task: Task,
  action: AskUserAction,
): Promise<ConsultApplyOutcome> {
  const question = askUserQuestion(action, task.id, briefCorrections(ctx.state, task.id));
  const asked: PlannerConversation = {
    call: 'plan',
    seat: ctx.seat,
    text: action.question,
    questions: [question],
    answers: [],
    answered: false,
  };
  const reply = await waitForPlannerReply(ctx, asked);
  if (reply === undefined && question.default === undefined)
    return {
      action: 'failed',
      reason: `The ${consultSeatRunner(ctx.seat)}'s question remains unanswered.`,
    };
  const answered = consultReplyAnswer(question, reply);
  // The transcript and the brief's log keep the seat's question; the instructions were context.
  const qa = answered.qa.map((pair) => ({ question: action.question, answer: pair.answer }));
  const recorded = transitionAndSave(ctx, ctx.state, {
    type: 'SET_PLANNER_CONVERSATION',
    conversation: {
      ...asked,
      answered: true,
      answers: [{ reply: asked.text, answer: answered.message.text }],
    },
  });
  const cleared = transitionAndSave(ctx, recorded, { type: 'CLEAR_PLANNER_CONVERSATION' });
  recordUserMessage({ ...ctx, phase: cleared.phase }, answered.message, {
    qa,
    answerIndex: (cleared.userAnswers?.length ?? 0) - 1,
  });
  const instructed = recordBriefCorrection(
    ctx,
    cleared,
    task.id,
    qa.map((pair) => `Question: ${pair.question}\nAnswer: ${pair.answer}`).join('\n\n'),
  );
  ctx.onStateChange?.(instructed);
  return { action: 'guidance', instructions: answered.message.text, context: null };
}

/**
 * Moves the run on the consult seat's answer: guidance hands back what the next attempt's error
 * block carries; a rewrite or a split rolls the current attempt back and replaces the task;
 * verify completes the task when its selection covers the criteria and the validation and
 * checks pass, and a pre_validation deny of that gate skips the task; ask-user puts the seat's
 * one question to the operator and hands the answer back as guidance; an answer that would
 * drop a criterion or one of its checks asks the operator through that same path.
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
      return applyRewrite(ctx, task, action, attempt);
    case 'split-task':
      return applySplit(ctx, task, action, attempt);
    case 'verify':
      return applyVerify(ctx, task, action, attempt);
    case 'ask-user':
      return applyAskUser(ctx, task, action);
    default:
      return assertNever(action);
  }
}
