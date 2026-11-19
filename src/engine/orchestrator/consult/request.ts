import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { plannerFixWork } from '../../../core/review/stuck.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { lineageIdOf, nextTaskIds } from '../../../core/state/task-insert.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { buildConsultPrompt } from '../../spec/prompts/consult/build.js';
import type { ConsultPromptInput } from '../../spec/prompts/consult/types.js';
import { runBaseOf } from '../isolation/run-base/tree.js';
import { resolveRunUniverse, runUserFiles } from '../evidence/review-packet/sections-io.js';
import { publishConsultAnswered } from '../publish/recovery.js';
import { publishRunnerCallEvent } from '../publish/runner.js';
import { readWorkspaceSeed } from '../isolation/seed.js';
import { askPlannerSession, type PlannerSessionTurn } from '../planner-session.js';
import { addUsageAndSave } from '../state-ops/usage.js';
import { transitionAndSave } from '../state-ops/transition.js';
import {
  checkRegistry,
  enabledReviewChecks,
  planApprovesNpmScripts,
} from '../validation/checks/runner.js';
import { buildStageContext } from '../validation/run.js';
import type { ConsultRequestInput, ConsultContext, ConsultOutcome } from './types.js';
import { answerContract } from './answer-contract.js';
import { taskDiff } from './task-diff.js';

/** The failures a consult produced, including returned protocol errors the caller throws. */
const consultErrors = new WeakSet<object>();

/** Whether `err` came out of a consult, for a caller that halts on that failure. */
export function isConsultError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && consultErrors.has(err);
}

/**
 * The user's own files the run left alone, which a fix task never targets. The answer's specs are
 * fix tasks when the task is one or when a stuck review asks, whatever its target. A plan task's
 * consult keeps no files out, and neither does an older run that recorded no files changed when it
 * started: the final review refuses that run with its own error.
 */
async function consultUserFiles(
  ctx: ConsultContext,
  input: ConsultRequestInput,
): Promise<ReadonlySet<string>> {
  const baseline = ctx.state.changedFilesBaseline;
  if (input.task.fix === undefined && input.stuck === undefined) return new Set();
  if (baseline?.runStartChangedFiles === undefined) return new Set();
  return runUserFiles(
    await resolveRunUniverse({
      workspaceDir: ctx.workspaceDir,
      baseline,
      runBase: runBaseOf(ctx, ctx.state),
    }),
  );
}

function promptInput(
  ctx: ConsultContext,
  input: ConsultRequestInput,
  taskDiff: ConsultPromptInput['taskDiff'],
): ConsultPromptInput {
  const { state } = ctx;
  const lineage = state.lineages?.[lineageIdOf(input.task)];
  return {
    workspaceDir: ctx.workspaceDir,
    reason: input.reason,
    plan: state.plan,
    task: input.task,
    revisions: lineage?.replacedParents ?? [],
    taskDiff,
    failedAttempts: lineage?.attemptFailures ?? [],
    failingOutput: input.failingOutput,
    report: input.report ?? null,
    earlierConsults: lineage?.consultRecords ?? [],
    otherTasks: state.tasks.filter((task) => task.id !== input.task.id),
    operatorInstructions: lineage?.corrections ?? [],
    writesFiles: resolveImplementerProfiles(ctx.config).defaultProfile.capabilities.writesFiles,
  };
}

/** The ids of the briefs the answer adds: a split's, or the next fix cycle of a stuck review. */
function answerTaskIds(
  state: WorkflowState,
  input: ConsultRequestInput,
  answer: ConsultAnswer,
): TaskId[] | null {
  const action = answer.answer;
  const count =
    input.stuck !== undefined
      ? action.action === 'accept' || action.action === 'cannot'
        ? 0
        : plannerFixWork(input.stuck.fixWork, action, input.stuck.blockerIds).fixTasks.length
      : action.action === 'split-task'
        ? action.tasks.length
        : 0;
  return count === 0 ? null : nextTaskIds(state.tasks, count);
}

/** What the consult answer did, for the transcript: a replacement's new revision, the checks. */
function publishAnswer(
  ctx: ConsultContext,
  state: WorkflowState,
  input: ConsultRequestInput,
  answer: ConsultAnswer,
): void {
  publishConsultAnswered(
    { bus: ctx.bus, phase: state.phase },
    {
      taskId: input.task.id,
      reason: input.reason,
      action: answer.answer.action,
      diagnosis: answer.answer.diagnosis,
      newTaskIds: answerTaskIds(state, input, answer),
      ...(answer.answer.action === 'rewrite-task' &&
        input.stuck === undefined && {
          revision: (input.task.revision ?? 1) + 1,
        }),
      ...(answer.answer.action === 'verify' && { checkIds: answer.answer.checkIds }),
      ...(answer.answer.action === 'accept' && { note: answer.answer.note }),
    },
  );
}

/**
 * Asks the planner about one task, a plan task or a fix task the review wrote, and records its
 * answer. The planner continues its session.
 */
export async function requestConsult(
  ctx: ConsultContext,
  input: ConsultRequestInput,
): Promise<ConsultOutcome> {
  const ref = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  const usageCtx = { ...ref, bus: ctx.bus };
  let state = ctx.state;
  const apply = (next: WorkflowState): void => {
    state = next;
    ctx.onStateChange?.(next);
  };

  const diff = await taskDiff(ctx.workspaceDir, ctx.state, input.task, ref);
  const prompt = promptInput(ctx, input, diff);
  const contract = answerContract(input.task, input.reason, input.stuck, {
    known: new Set(
      checkRegistry({
        plan: ctx.state.plan,
        tasks: ctx.state.tasks,
        reviewChecks: enabledReviewChecks(ctx.config, ctx.state.plan),
      }).keys(),
    ),
    state: ctx.state,
    npmScriptsApproved: planApprovesNpmScripts({ config: ctx.config, state: ctx.state }),
    projectDir: ctx.workspaceDir,
    renderCommand: ctx.config.validation.render,
    testChecks: buildStageContext({
      projectDir: ctx.workspaceDir,
      config: ctx.config,
      discoveredValidation: ctx.state.discoveredValidation,
      notices: { bus: ctx.bus, phase: ctx.state.phase },
    }),
    pendingFiles: ctx.state.tasks
      .filter((task) => task.status === 'pending' && task.id !== input.task.id)
      .flatMap((task) => task.suggestedFiles),
    userFiles: await consultUserFiles(ctx, input),
  });
  // A native planner session predating planning isolation still belongs to the checkout.
  const plannerDir = (await readWorkspaceSeed(ref)) === null ? ctx.projectDir : ctx.workspaceDir;
  const onCallEvent = (event: RunnerCallEvent): void =>
    publishRunnerCallEvent(
      { bus: ctx.bus, phase: state.phase, rootDir: plannerDir, taskId: input.task.id },
      event,
    );
  // A fix task's brief comes from the review, not from the planning thread, so every consult on a
  // fix lineage sends the whole prompt, also on a live session.
  const repair = input.task.fix !== undefined && input.stuck === undefined;
  const answer = await askPlannerSession(
    {
      ...ref,
      workspaceDir: plannerDir,
      bus: ctx.bus,
      planner: ctx.planner,
      config: ctx.config,
      state,
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      onStateChange: apply,
    },
    {
      ...contract,
      compose: (turn: PlannerSessionTurn) =>
        buildConsultPrompt({ ...prompt, resumed: turn.onSession && !repair }),
      onCallEvent,
    },
  ).catch((thrown: unknown) => {
    if (typeof thrown === 'object' && thrown !== null) consultErrors.add(thrown);
    throw thrown;
  });

  if ('error' in answer.result) {
    apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
    consultErrors.add(answer.result.error);
    return { error: answer.result.error };
  }

  const consulted = answer.result.value;
  apply(
    transitionAndSave(ref, state, {
      type: 'RECORD_CONSULT',
      taskId: input.task.id,
      revision: input.task.revision ?? 1,
      reason: input.reason,
      answer: consulted,
    }),
  );
  publishAnswer(ctx, state, input, consulted);
  apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
  return { answer: consulted };
}
