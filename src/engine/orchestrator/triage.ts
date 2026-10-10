import { fixBriefDescription, type FixFinding } from '../../core/review/fix-task.js';
import type { Config } from '../../core/schemas/config.js';
import type { Plan } from '../../core/schemas/plan.js';
import { REVIEW_CHECK_ID, type TriageInput, type TriageResult } from '../../core/schemas/review.js';
import type { SpecMetadata } from '../../core/paths-io.js';
import type { Check, Task, TaskId } from '../../core/schemas/task.js';
import {
  fixCyclesOf,
  type ReviewChecksRecord,
  type ReviewRecord,
  type TriageRecord,
  type WorkflowState,
} from '../../core/schemas/workflow.js';
import { verificationKey, type Finding } from '../../core/review/verdict.js';
import { insertTasks } from '../../core/state/task-insert.js';
import type { EventBus } from '../events/types.js';
import { checkTaskIdentities } from '../spec/plan-checks.js';
import { taskFromSpec } from '../spec/plan-tasks.js';
import { writeTasksArtifact } from './artifact-write.js';
import { transitionAndSave } from './state-ops.js';
import type { WorkflowContext } from './types.js';
import {
  checkRegistry,
  enabledReviewChecks,
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
} from './validation/run-checks.js';
import { recordCheckRuns } from './evidence/record-checks.js';
import { runBaseOf } from './isolation/base-tree.js';
import type { ValidationCommandRunner } from './validation/types.js';
import { checkFailureText } from './validation/failure-text.js';

export function checkVerificationStatus(
  runs: readonly CheckRunResult[],
): 'pass' | 'fail' | 'unverified' {
  if (runs.some((run) => run.status === 'fail')) return 'fail';
  if (runs.length > 0 && runs.every((run) => run.status === 'pass')) return 'pass';
  return 'unverified';
}

export function checkVerificationOutput(runs: readonly CheckRunResult[]): string {
  return runs
    .map((run) => {
      if (run.status === 'fail') return checkFailureText(run);
      const output = run.output.trim();
      return `${run.checkId}: ${run.status}${output === '' ? '' : ` — ${output}`}`;
    })
    .join('\n');
}

export type TriageContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
}>;

export function triageContractErrors(
  result: TriageResult,
  plan: Plan | undefined,
  findings: readonly Finding[],
  inputs: readonly TriageInput[],
  tasks: readonly Task[] = [],
  reviewChecks?: readonly Check[] | undefined,
): string[] {
  const errors: string[] = [];
  const blocking = findings.filter(
    (finding) => finding.severity === 'blocking' && finding.kind !== 'unverified',
  );
  if (result.ask === null) {
    const answered = new Map<string, number>();
    const count = (id: string): void => {
      answered.set(id, (answered.get(id) ?? 0) + 1);
    };
    for (const task of result.fixTasks) for (const id of task.findingIds) count(id);
    for (const rejected of result.rejected) count(rejected.findingId);
    for (const verified of result.verify) count(verified.findingId);
    for (const finding of blocking) {
      const times = answered.get(finding.id) ?? 0;
      if (times === 0) {
        errors.push(`Blocking finding ${finding.id} is not fixed, rejected or verified.`);
      } else if (times > 1) {
        errors.push(`Blocking finding ${finding.id} is answered more than once.`);
      }
    }
    for (const input of inputs) {
      const times = answered.get(input.id) ?? 0;
      if (times === 0) {
        errors.push(`Pending input ${input.id} is not fixed, rejected or verified.`);
      } else if (times > 1) {
        errors.push(`Pending input ${input.id} is answered more than once.`);
      }
    }
    const known = new Set([...blocking.map((finding) => finding.id), ...inputs.map((i) => i.id)]);
    for (const id of answered.keys()) {
      if (!known.has(id)) {
        errors.push(`${id} is not one of the blocking findings or pending inputs.`);
      }
    }
  }

  const pendingIds = new Set(inputs.map((input) => input.id));
  for (const entry of result.rejected) {
    if (!pendingIds.has(entry.findingId))
      errors.push(`Rejected ${entry.findingId} is not a pending input.`);
  }

  const fixBatch = Math.max(1, ...tasks.map((task) => task.batch ?? 1)) + 1;
  errors.push(
    ...checkTaskIdentities(
      [...result.fixTasks.map((task) => ({ ...task, batch: fixBatch }))],
      tasks.map((task) => ({ ...task, batch: task.batch ?? 1 })),
    ).map((error) => error.message),
  );
  const checks = checkRegistry({ plan, tasks, reviewChecks });
  for (const task of result.fixTasks) {
    for (const id of task.findingIds) {
      const finding = findings.find((finding) => finding.id === id);
      if (
        finding !== undefined &&
        (finding.kind === 'unverified' || finding.severity === 'minor')
      ) {
        errors.push(`Finding ${id} cannot be assigned to a fix task.`);
      }
      for (const checkId of finding?.checkIds ?? []) {
        if (!checks.has(checkId)) {
          errors.push(`Finding ${id} names unknown check ${checkId}.`);
        }
      }
    }
  }
  const criteria = new Set((plan?.criteria ?? []).map((criterion) => criterion.id));
  for (const task of result.fixTasks) {
    for (const criterionId of task.criteria) {
      if (!criteria.has(criterionId)) {
        errors.push(`Fix task ${task.id} names unknown criterion ${criterionId}.`);
      }
    }
  }
  for (const entry of result.verify) {
    for (const checkId of entry.checkIds) {
      if (!checks.has(checkId)) {
        errors.push(`Verify for ${entry.findingId} names unknown check ${checkId}.`);
      }
    }
  }
  return errors;
}

export async function runTriageVerification(
  ctx: TriageContext,
  state: WorkflowState,
  result: TriageResult,
): Promise<NonNullable<TriageRecord['verification']>> {
  if (result.verify.length === 0) return [];
  const entries: NonNullable<TriageRecord['verification']> = [];
  for (const entry of result.verify) {
    const runs = await runChecks(entry.checkIds, {
      plan: state.plan,
      tasks: state.tasks,
      reviewChecks: enabledReviewChecks(ctx.config, state.reviewChecks),
      base: runBaseOf({ projectDir: ctx.projectDir, sessionId: ctx.sessionId }, state),
      projectDir: ctx.workspaceDir,
      sessionId: ctx.sessionId,
      checkoutDir: ctx.projectDir,
      config: ctx.config,
      bus: ctx.bus,
      phase: state.phase,
      npmScriptsApproved: planApprovesNpmScripts({ config: ctx.config, state }),
      ...(state.discoveredValidation !== undefined && {
        discoveredValidation: state.discoveredValidation,
      }),
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      ...(ctx.runCommand !== undefined && { runCommand: ctx.runCommand }),
    });
    await recordCheckRuns({
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      workspaceDir: ctx.workspaceDir,
      state,
      runs,
    });
    entries.push({
      id: verificationKey('finding', entry.findingId),
      status: checkVerificationStatus(runs),
      output: checkVerificationOutput(runs),
    });
  }
  return entries;
}

function findingFor(
  id: string,
  review: ReviewRecord | undefined,
  inputs: readonly TriageInput[],
  reviewChecks: ReviewChecksRecord | undefined,
): FixFinding | undefined {
  const finding = review?.verdict.findings.find((candidate) => candidate.id === id);
  if (finding !== undefined) {
    const commands: Record<string, string> = {};
    const failureKeys: Record<string, string[]> = {};
    const redKeys: Record<string, string[]> = {};
    for (const id of finding.checkIds ?? []) {
      if (REVIEW_CHECK_ID.test(id)) {
        const check = reviewChecks?.plan.commands.find((check) => check.id === id);
        if (check !== undefined) commands[id] = check.command;
      }
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
      const finding = findingFor(id, review, inputs, state.reviewChecks);
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

/** Review fix work spends one fix cycle; appended tasks announce it. */
export function startFixCycle(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  taskIds: readonly TaskId[];
}): WorkflowState {
  const { wctx } = args;
  const state = transitionAndSave(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId },
    args.state,
    { type: 'START_FIX_CYCLE' },
  );
  args.setTrackedState(state);
  if (args.taskIds.length > 0) {
    wctx.bus.publish({
      type: 'review_fix_started',
      ts: Date.now(),
      phase: state.phase,
      cycle: fixCyclesOf(state).used,
      taskIds: [...args.taskIds],
    });
  }
  return state;
}
