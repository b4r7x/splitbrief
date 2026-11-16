import { type FixFinding, fixBriefDescription } from '../../../core/review/fix/task.js';
import type { Plan } from '../../../core/schemas/plan.js';
import {
  type TriageInput,
  REVIEW_CHECK_ID,
  type TriageResult,
} from '../../../core/schemas/review/verdict.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ReviewRecord } from '../../../core/schemas/workflow/review-record.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { fixCyclesOf } from '../../../core/state/selectors.js';
import type { SpecMetadata } from '../../../core/sessions/spec-files.js';
import { insertTasks } from '../../../core/state/task-insert.js';
import { taskFromSpec } from '../../spec/plan/tasks.js';
import { publishTasksPlanned } from '../publish/task.js';
import { publishFixCycleStarted } from '../publish/review.js';
import { writeTasksArtifact } from '../plan-files/write.js';
import { transitionAndSave } from '../state-ops/transition.js';
import type { WorkflowContext } from '../types.js';
import { reviewCheckList } from '../validation/checks/runner.js';
import type { TriageContext } from './types.js';

function findingFor(
  id: string,
  review: ReviewRecord | undefined,
  inputs: readonly TriageInput[],
  plan: Plan | undefined,
): FixFinding | undefined {
  const finding = review?.verdict.findings.find((candidate) => candidate.id === id);
  if (finding !== undefined) {
    const commands: Record<string, string> = {};
    const failureKeys: Record<string, string[]> = {};
    const redKeys: Record<string, string[]> = {};
    for (const id of finding.checkIds ?? []) {
      const command = REVIEW_CHECK_ID.test(id)
        ? reviewCheckList(plan).find((check) => check.id === id)?.value
        : inputs.find((input) => input.checkIds?.includes(id) && input.command !== undefined)
            ?.command;
      if (command !== undefined) commands[id] = command;
      const keys = [
        ...new Set(
          inputs
            .filter((input) => input.file === finding.file && input.checkIds?.includes(id))
            .flatMap((input) => input.failureKeys ?? []),
        ),
      ];
      if (keys.length > 0) failureKeys[id] = keys;
      const red = [
        ...new Set(
          inputs
            .filter((input) => input.checkIds?.includes(id))
            .flatMap((input) => input.redKeys ?? []),
        ),
      ];
      if (red.length > 0) redKeys[id] = red;
    }
    return {
      id: finding.id,
      text: finding.text,
      acceptance: finding.acceptance,
      ...(finding.file !== null && { file: finding.file }),
      ...(finding.checkIds !== null && { checkIds: finding.checkIds }),
      ...(Object.keys(commands).length > 0 && { commands }),
      ...(Object.keys(failureKeys).length > 0 && { failureKeys }),
      ...(Object.keys(redKeys).length > 0 && { redKeys }),
    };
  }
  const input = inputs.find((candidate) => candidate.id === id);
  if (input === undefined) return undefined;
  const commands: Record<string, string> = {};
  const failureKeys: Record<string, string[]> = {};
  const redKeys: Record<string, string[]> = {};
  if (input.command !== undefined) {
    for (const id of input.checkIds ?? []) commands[id] = input.command;
  }
  if (input.failureKeys !== undefined && input.failureKeys.length > 0) {
    for (const id of input.checkIds ?? []) failureKeys[id] = input.failureKeys;
  }
  if (input.redKeys !== undefined && input.redKeys.length > 0) {
    for (const id of input.checkIds ?? []) redKeys[id] = input.redKeys;
  }
  return {
    id: input.id,
    text: input.text,
    acceptance: null,
    ...(input.file !== null && { file: input.file }),
    ...(input.checkIds !== undefined && { checkIds: input.checkIds }),
    ...(Object.keys(commands).length > 0 && { commands }),
    ...(Object.keys(failureKeys).length > 0 && { failureKeys }),
    ...(Object.keys(redKeys).length > 0 && { redKeys }),
    ...(input.output !== undefined && { output: input.output }),
  };
}

function maxPlanBatch(tasks: readonly Task[]): number {
  let highest = 1;
  for (const task of tasks) {
    if (task.fix !== undefined) continue;
    const batch = task.batch ?? 1;
    if (batch > highest) highest = batch;
  }
  return highest;
}

export function applyTriage(
  ctx: Pick<TriageContext, 'projectDir' | 'sessionId' | 'workspaceDir'> & {
    metadata: SpecMetadata;
  },
  state: WorkflowState,
  review: ReviewRecord | undefined,
  inputs: readonly TriageInput[],
  result: TriageResult,
  batch?: number | undefined,
  afterTaskId?: TaskId | undefined,
): Readonly<{ state: WorkflowState; tasks: Task[] }> {
  if (result.fixTasks.length === 0) return { state, tasks: [] };
  const cycle = fixCyclesOf(state).used + 1;
  const fixBatch = batch ?? maxPlanBatch(state.tasks) + cycle;
  const converted = insertTasks(result.fixTasks, state.tasks, (spec) => {
    const task = taskFromSpec(spec, ctx.workspaceDir);
    const findings = spec.findingIds.flatMap((id) => {
      const finding = findingFor(id, review, inputs, state.plan);
      return finding === undefined ? [] : [finding];
    });
    return {
      ...task,
      batch: fixBatch,
      fix: { cycle, findings },
      description: fixBriefDescription(task.description, findings),
    };
  });
  const ref = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  const next = transitionAndSave(ref, state, {
    type: 'INSERT_TASKS',
    parentId: null,
    ...(afterTaskId !== undefined && { afterTaskId }),
    tasks: converted,
  });
  writeTasksArtifact(ref, next.tasks, ctx.metadata);
  return {
    state: next,
    tasks: converted.map(
      (task) => next.tasks.find((candidate) => candidate.id === task.id) ?? task,
    ),
  };
}

/** Review fix work spends one fix cycle and announces it; inserted tasks re-plan the list. */
export function startFixCycle(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  taskIds: readonly TaskId[];
}): WorkflowState {
  const { wctx } = args;
  const lastFixTaskId = args.taskIds.at(-1);
  const state = transitionAndSave(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId },
    args.state,
    { type: 'START_FIX_CYCLE', ...(lastFixTaskId !== undefined && { lastFixTaskId }) },
  );
  args.setTrackedState(state);
  if (args.taskIds.length > 0) {
    publishTasksPlanned({ bus: wctx.bus, phase: state.phase }, state.tasks);
  }
  publishFixCycleStarted(wctx.bus, state, args.taskIds);
  return state;
}
