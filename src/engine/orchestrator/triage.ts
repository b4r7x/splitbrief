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
import {
  findingInReviewScope,
  verificationKey,
  type Finding,
  type ReviewScope,
} from '../../core/review/verdict.js';
import { insertTasks } from '../../core/state/task-insert.js';
import type { EventBus } from '../events/types.js';
import { checkTaskIdentities } from '../spec/plan-checks.js';
import { taskFromSpec } from '../spec/plan-tasks.js';
import { writeTasksArtifact } from './artifact-write.js';
import { transitionAndSave } from './state-ops.js';
import { publishFixCycleStarted, publishTasksPlanned } from './events.js';
import type { WorkflowContext } from './types.js';
import {
  checkRegistry,
  enabledReviewChecks,
  createCheckRunner,
  planApprovesNpmScripts,
  type CheckRunResult,
  type RunChecksOptions,
} from './validation/run-checks.js';
import { runCheckWithRows } from './run/pre-review-checks.js';
import { recordCheckRuns } from './evidence/record-checks.js';
import { runBaseOf } from './isolation/base-tree.js';
import type { ValidationCommandRunner } from './validation/types.js';
import { checkFailureText, newFailureKeys } from './validation/failure-text.js';
import { uniqueSorted } from '../../utils/collections.js';

/** A red whose failures were all red at the run base too verifies the claim like a pass. */
function checkVerificationStatus(runs: readonly CheckRunResult[]): 'pass' | 'fail' | 'unverified' {
  if (runs.some((run) => newFailureKeys(run).length > 0)) return 'fail';
  if (runs.length > 0 && runs.every((run) => run.status === 'pass' || run.status === 'fail')) {
    return 'pass';
  }
  return 'unverified';
}

function checkVerificationOutput(runs: readonly CheckRunResult[]): string {
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
  tasks: readonly Task[],
  reviewChecks: readonly Check[] | undefined,
  scope: ReviewScope,
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
    // A blocking finding under a pending input's id is that input: the input's rule answers it.
    const inputIds = new Set(inputs.map((input) => input.id));
    for (const finding of blocking.filter(
      (finding) => findingInReviewScope(finding, scope) && !inputIds.has(finding.id),
    )) {
      const times = answered.get(finding.id) ?? 0;
      if (times === 0) {
        errors.push(`Blocking finding ${finding.id} is not fixed, rejected or verified.`);
      } else if (times > 1) {
        errors.push(`Blocking finding ${finding.id} is answered more than once.`);
      }
    }
    for (const input of inputs) {
      const times = answered.get(input.id) ?? 0;
      // Fix tasks may share an input's failures: each task names it once, and nothing else does.
      const sharedByFixTasks =
        result.fixTasks.every(
          (task) => task.findingIds.filter((id) => id === input.id).length <= 1,
        ) &&
        !result.rejected.some((entry) => entry.findingId === input.id) &&
        !result.verify.some((entry) => entry.findingId === input.id);
      if (times === 0) {
        errors.push(`Pending input ${input.id} is not fixed, rejected or verified.`);
      } else if (times > 1 && !sharedByFixTasks) {
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

  const pending = new Map(inputs.map((input) => [input.id, input]));
  for (const entry of result.rejected) {
    const input = pending.get(entry.findingId);
    if (input === undefined) errors.push(`Rejected ${entry.findingId} is not a pending input.`);
    else if (input.source === 'apply')
      errors.push(`Rejected ${entry.findingId} is an Apply conflict; it needs a fix task.`);
    if (entry.reason.trim() === '') errors.push(`Rejected ${entry.findingId} gives no reason.`);
  }
  for (const entry of result.verify) {
    if (pending.get(entry.findingId)?.source === 'apply')
      errors.push(`Verified ${entry.findingId} is an Apply conflict; it needs a fix task.`);
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
      if (finding !== undefined) {
        if (!findingInReviewScope(finding, scope)) {
          errors.push(
            `Finding ${id} is outside the task review scope and cannot be assigned to a fix task.`,
          );
        } else if (finding.kind === 'unverified' || finding.severity === 'minor') {
          errors.push(`Finding ${id} cannot be assigned to a fix task.`);
        }
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
      if (scope.kind === 'task' && !scope.criterionIds.includes(criterionId)) {
        errors.push(
          `Fix task ${task.id} names criterion ${criterionId} outside the task review scope.`,
        );
      }
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

/** A fix task never targets a file already changed when the run started that the run left alone. */
export function fixTaskTargetErrors(
  result: TriageResult,
  userFiles: ReadonlySet<string>,
): string[] {
  return result.fixTasks.flatMap((task) =>
    uniqueSorted([
      ...task.suggestedFiles,
      ...(task.protectedOperations ?? []).map((operation) => operation.path),
    ])
      .filter((path) => userFiles.has(path))
      .map(
        (path) =>
          `Fix task ${task.id} targets ${path}: it was already changed when this run started, and this run did not change it.`,
      ),
  );
}

/**
 * Runs the checks behind one claim of a review and records them. A red keeps as pre-existing the
 * failures `preExistingChecks`, this review's run base split, names for the same check.
 */
export async function verifyClaimChecks(
  ctx: TriageContext,
  state: WorkflowState,
  checkIds: readonly string[],
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>,
  answeredAt: string,
): Promise<{ status: 'pass' | 'fail' | 'unverified'; output: string }> {
  const checkOptions: RunChecksOptions = {
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
    // A verify runs a red stored before the reviewer answered again, so a flaky red does not stand
    // on a stored run. A red this verify stored stands when a continue verifies the same answer.
    results: {
      ref: { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
      state,
      tree: 'workspace',
      rerunRedBefore: answeredAt,
    },
    ...(ctx.signal !== undefined && { signal: ctx.signal }),
    ...(ctx.runCommand !== undefined && { runCommand: ctx.runCommand }),
  };
  const prepare = createCheckRunner(checkOptions);
  const registry = checkRegistry(checkOptions);
  const notices = { bus: ctx.bus, phase: state.phase };
  const runs: CheckRunResult[] = [];
  for (const checkId of new Set(checkIds)) {
    const check = registry.get(checkId);
    const run: CheckRunResult =
      check === undefined
        ? { checkId, status: 'unknown', output: `no check ${checkId}` }
        : await runCheckWithRows({ check, prepare, notices, moment: 'verify' });
    if (run.status !== 'fail' || run.failure.placeholder !== undefined) {
      runs.push(run);
      continue;
    }
    const atBase = preExistingChecks.find((entry) => entry.id === run.checkId)?.keys ?? [];
    const preExisting = run.failure.keys.filter((key) => atBase.includes(key));
    runs.push(preExisting.length > 0 ? { ...run, preExisting } : run);
  }
  await recordCheckRuns({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    state,
    runs,
  });
  return { status: checkVerificationStatus(runs), output: checkVerificationOutput(runs) };
}

export async function runTriageVerification(
  ctx: TriageContext,
  state: WorkflowState,
  result: TriageResult,
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>,
  answeredAt: string,
): Promise<NonNullable<TriageRecord['verification']>> {
  const entries: NonNullable<TriageRecord['verification']> = [];
  for (const entry of result.verify) {
    entries.push({
      id: verificationKey('finding', entry.findingId),
      ...(await verifyClaimChecks(ctx, state, entry.checkIds, preExistingChecks, answeredAt)),
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
      const command = REVIEW_CHECK_ID.test(id)
        ? reviewChecks?.plan.commands.find((check) => check.id === id)?.command
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
