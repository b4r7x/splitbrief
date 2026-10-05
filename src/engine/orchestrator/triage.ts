import { fixBriefDescription, type FixFinding } from '../../core/review/fix-task.js';
import type { z } from 'zod';
import type { Config } from '../../core/schemas/config.js';
import type { Plan } from '../../core/schemas/plan.js';
import type { TriageInput } from '../../core/schemas/review.js';
import {
  TRIAGE_RESULT_JSON_SCHEMA,
  TriageResultSchema,
  type TriageResult,
} from '../../core/schemas/review.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import {
  fixCyclesOf,
  plannerCallsOf,
  type PlannerConversation,
  type ReviewRecord,
  type TriageRecord,
  type WorkflowState,
} from '../../core/schemas/workflow.js';
import { reviewOutcomeOf, verificationKey, type Finding } from '../../core/review/verdict.js';
import { insertTasks } from '../../core/state/task-insert.js';
import { nowIso } from '../../utils/format-time.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { EventBus } from '../events/types.js';
import type { Planner } from '../planners/types.js';
import type { SeatProtocolError } from '../runners/typed-output.js';
import { checkTaskIdentities } from '../spec/plan-checks.js';
import { buildConsultBoundRecoveryIssue, plannerCallsSpent } from './recovery/builders/consult.js';
import { buildReviewFailedRecoveryIssue } from './recovery/builders/task.js';
import { buildSeatProtocolErrorRecoveryIssue } from './recovery/builders/seat-protocol.js';
import { taskFromSpec } from '../spec/plan-tasks.js';
import { buildTriagePrompt, type TriagePromptInput } from '../spec/prompts/triage.js';
import { checkVerificationOutput, checkVerificationStatus } from './final-review.js';
import { publishError, publishRunnerCallEvent } from './events.js';
import { runSeatCall, seatFailureFromError } from './escalation/seat-wait.js';
import { waitForPlannerReply } from './planning/call-loop.js';
import { askPlannerSession, type PlannerSessionAnswer } from './planner-session.js';
import { addUsageAndSave, raisePendingRecovery, transitionAndSave } from './state-ops.js';
import type { OrchestratorCallbacks, WorkflowContext, WorkflowSinks } from './types.js';
import { checkRegistry, planApprovesNpmScripts, runChecks } from './validation/run-checks.js';
import { recordCheckRuns } from './evidence/record-checks.js';
import type { ValidationCommandRunner } from './validation/types.js';

export type TriageContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  planner: Pick<Planner, 'capabilities' | 'typedCall'>;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}>;

export type TriageRequestInput = Readonly<{
  review?: ReviewRecord | undefined;
  inputs: readonly TriageInput[];
  batch?: number | undefined;
  afterTaskId?: TaskId | undefined;
}>;

export type TriageRequestOutcome =
  | Readonly<{ result: TriageResult }>
  | Readonly<{ error: SeatProtocolError }>
  | Readonly<{ kind: 'bound-spent' }>;

type TriageRun =
  | Readonly<{ kind: 'answer'; answer: PlannerSessionAnswer<TriageResult> }>
  | Readonly<{ kind: 'threw'; error: unknown }>;

export type TriageOutcome =
  | Readonly<{ kind: 'triaged'; tasks: Task[] }>
  | Readonly<{ kind: 'error'; error: SeatProtocolError }>
  | Readonly<{ kind: 'unanswered' }>
  | Readonly<{ kind: 'bound-spent' }>;

export function triageContractErrors(
  result: TriageResult,
  plan: Plan | undefined,
  findings: readonly Finding[],
  inputs: readonly TriageInput[],
  tasks: readonly Task[] = [],
): string[] {
  const errors: string[] = [];
  if (result.ask === null) {
    const answered = new Map<string, number>();
    const count = (id: string): void => {
      answered.set(id, (answered.get(id) ?? 0) + 1);
    };
    for (const task of result.fixTasks) for (const id of task.findingIds) count(id);
    for (const rejected of result.rejected) count(rejected.findingId);
    for (const verified of result.verify) count(verified.findingId);
    for (const finding of findings) {
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
    const known = new Set([...findings.map((finding) => finding.id), ...inputs.map((i) => i.id)]);
    for (const id of answered.keys()) {
      if (!known.has(id)) {
        errors.push(`${id} is not one of the blocking findings or pending inputs.`);
      }
    }
  }

  const fixBatch = Math.max(1, ...tasks.map((task) => task.batch ?? 1)) + 1;
  errors.push(
    ...checkTaskIdentities(
      [...result.fixTasks.map((task) => ({ ...task, batch: fixBatch }))],
      tasks.map((task) => ({ ...task, batch: task.batch ?? 1 })),
    ).map((error) => error.message),
  );
  for (const task of result.fixTasks) {
    for (const id of task.findingIds) {
      const finding = findings.find((finding) => finding.id === id);
      if (
        finding !== undefined &&
        (finding.kind === 'unverified' || finding.severity === 'minor')
      ) {
        errors.push(`Finding ${id} cannot be assigned to a fix task.`);
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
  const checks = checkRegistry({ plan, tasks });
  for (const entry of result.verify) {
    for (const checkId of entry.checkIds) {
      if (!checks.has(checkId)) {
        errors.push(`Verify for ${entry.findingId} names unknown check ${checkId}.`);
      }
    }
  }
  return errors;
}

function triageResultSchema(
  plan: Plan | undefined,
  findings: readonly Finding[],
  inputs: readonly TriageInput[],
  tasks: readonly Task[],
): z.ZodType<TriageResult> {
  return TriageResultSchema.superRefine((candidate, ctx) => {
    for (const message of triageContractErrors(candidate, plan, findings, inputs, tasks)) {
      ctx.addIssue({ code: 'custom', message });
    }
  });
}

function promptInput(
  state: WorkflowState,
  ctx: TriageContext,
  input: TriageRequestInput,
  findings: readonly Finding[],
): TriagePromptInput {
  return {
    workspaceDir: ctx.workspaceDir,
    plan: state.plan,
    tasks: state.tasks,
    findings,
    verdict: input.review?.verdict,
    inputs: input.inputs,
    verification: input.review?.verification ?? [],
    earlierConsults: Object.values(state.lineages ?? {}).flatMap(
      (lineage) => lineage.consultRecords,
    ),
    earlierTriage: state.triage ?? [],
    planningAnswers: state.userAnswers ?? [],
    cycle: fixCyclesOf(state).used + 1,
  };
}

async function runTriageVerification(
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

export async function requestTriage(
  ctx: TriageContext,
  input: TriageRequestInput,
): Promise<TriageRequestOutcome> {
  const ref = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  if (plannerCallsSpent(ctx.state)) {
    const pending = ctx.state.pendingTriage;
    const saved = transitionAndSave(ref, ctx.state, {
      type: 'QUEUE_TRIAGE',
      inputs: [...input.inputs],
      ...(pending?.question !== undefined && { question: pending.question }),
    });
    ctx.onStateChange?.(saved);
    return { kind: 'bound-spent' };
  }
  const usageCtx = { ...ref, bus: ctx.bus };
  let state = ctx.state;
  const apply = (next: WorkflowState): void => {
    state = next;
    ctx.onStateChange?.(next);
  };

  const findings = input.review === undefined ? [] : reviewOutcomeOf(input.review).blocking;
  const prompt = promptInput(state, ctx, input, findings);
  const compose = (): string => buildTriagePrompt(prompt);
  const call = {
    compose,
    onCallEvent: (event: RunnerCallEvent) =>
      publishRunnerCallEvent({ bus: ctx.bus, phase: state.phase }, event),
  };
  const session = {
    ...ref,
    bus: ctx.bus,
    planner: ctx.planner,
    state,
    ...(ctx.signal !== undefined && { signal: ctx.signal }),
    onStateChange: apply,
  };

  const asked = await runSeatCall<TriageRun>(
    {
      ref: usageCtx,
      state,
      seat: 'plan',
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      onStateChange: apply,
    },
    async (signal) => {
      const attemptSession = { ...session, state, signal };
      try {
        const answer: PlannerSessionAnswer<TriageResult> = await askPlannerSession(attemptSession, {
          ...call,
          schema: triageResultSchema(state.plan, findings, input.inputs, state.tasks),
          jsonSchema: TRIAGE_RESULT_JSON_SCHEMA,
          schemaName: 'triage_result',
        });
        const value: TriageRun = { kind: 'answer', answer };
        if ('error' in answer.result) {
          return { ok: false, failure: { message: answer.result.error.message }, value };
        }
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          failure: seatFailureFromError(error),
          value: { kind: 'threw', error },
        };
      }
    },
    // A thrown triage carries no usage, and a protocol answer is not retried.
    () => {},
  );

  if (asked.value.kind === 'threw') throw asked.value.error;
  const answer = asked.value.answer;

  if ('error' in answer.result) {
    apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
    return { error: answer.result.error };
  }

  const result = answer.result.value;
  const verification = await runTriageVerification(ctx, state, result);
  apply(
    transitionAndSave(ref, state, {
      type: 'RECORD_TRIAGE',
      record: {
        cycle: fixCyclesOf(state).used + 1,
        at: nowIso(),
        ...(input.review !== undefined && { reviewAt: input.review.at }),
        inputIds: [
          ...findings.map((finding) => finding.id),
          ...input.inputs.map((entry) => entry.id),
        ],
        result,
        ...(verification.length > 0 && { verification }),
      },
    }),
  );
  apply(transitionAndSave(ref, state, { type: 'COUNT_PLANNER_CALL' }));
  apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
  return { result };
}

function findingFor(
  id: string,
  review: ReviewRecord | undefined,
  inputs: readonly TriageInput[],
): FixFinding | undefined {
  const finding = review?.verdict.findings.find((candidate) => candidate.id === id);
  if (finding !== undefined) {
    return { id: finding.id, text: finding.text, acceptance: finding.acceptance };
  }
  const input = inputs.find((candidate) => candidate.id === id);
  if (input !== undefined) return { id: input.id, text: input.text, acceptance: null };
  return undefined;
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
  ctx: Pick<TriageContext, 'projectDir' | 'sessionId' | 'workspaceDir'>,
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
      const finding = findingFor(id, review, inputs);
      return finding === undefined ? [] : [finding];
    });
    return {
      ...task,
      batch: fixBatch,
      fix: { cycle, findings },
      description: fixBriefDescription(task.description, findings),
    };
  });
  const next = transitionAndSave({ projectDir: ctx.projectDir, sessionId: ctx.sessionId }, state, {
    type: 'INSERT_TASKS',
    parentId: null,
    ...(afterTaskId !== undefined && { afterTaskId }),
    tasks: converted,
  });
  return {
    state: next,
    tasks: converted.map(
      (task) => next.tasks.find((candidate) => candidate.id === task.id) ?? task,
    ),
  };
}

const TRIAGE_QUESTION_ID = 'triage-ask';

function askedConversation(question: string): PlannerConversation {
  return {
    call: 'plan',
    text: question,
    questions: [{ id: TRIAGE_QUESTION_ID, type: 'input', text: question }],
    answers: [],
    answered: false,
  };
}

export async function runTriage(
  ctx: TriageContext,
  input: TriageRequestInput,
): Promise<TriageOutcome> {
  let state = ctx.state;
  let inputs = [...input.inputs];
  const ref = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  const apply = (next: WorkflowState): void => {
    state = next;
    ctx.onStateChange?.(next);
  };

  for (;;) {
    let question = state.pendingTriage?.question;
    if (question == null) {
      const requested = await requestTriage(
        { ...ctx, state, onStateChange: apply },
        { review: input.review, inputs },
      );
      if ('kind' in requested) return requested;
      if ('error' in requested) return { kind: 'error', error: requested.error };
      const result = requested.result;
      if (result.ask === null) {
        const applied = applyTriage(
          ctx,
          state,
          input.review,
          inputs,
          result,
          input.batch,
          input.afterTaskId,
        );
        apply(applied.state);
        return { kind: 'triaged', tasks: applied.tasks };
      }
      question = result.ask;
      apply(transitionAndSave(ref, state, { type: 'QUEUE_TRIAGE', inputs, question }));
    }
    const reply = await waitForPlannerReply(
      { callbacks: ctx.callbacks, sinks: ctx.sinks, signal: ctx.signal },
      askedConversation(question.question),
    );
    if (reply === undefined) return { kind: 'unanswered' };
    const text = typeof reply === 'string' ? reply : reply.text;
    inputs = [
      ...inputs,
      { id: `A${inputs.length + 1}`, kind: 'answer', source: 'user', text, file: null },
    ];
    apply(transitionAndSave(ref, state, { type: 'QUEUE_TRIAGE', inputs }));
  }
}

/**
 * A check-sourced triage that could not answer — the planner-call bound, a seat
 * protocol error, or a question the run cannot answer — halts on the plan seat.
 * `source` names the check run that found the failures.
 */
export function haltUnansweredTriage(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  outcome: Exclude<TriageOutcome, { kind: 'triaged' }>;
  setTrackedState: (s: WorkflowState) => void;
  diagnosis: string;
  source: string;
}): WorkflowState {
  const { wctx, state, outcome } = args;
  const phase = state.phase;
  const plannerCalls = plannerCallsOf(state);
  const issue =
    outcome.kind === 'bound-spent'
      ? buildConsultBoundRecoveryIssue({
          reason: 'planner-calls-spent',
          lastDiagnosis: args.diagnosis,
          plannerCalls: plannerCalls.used,
          plannerCallAllowance: plannerCalls.allowance,
          phase,
          createdAt: nowIso(),
        })
      : outcome.kind === 'error'
        ? buildSeatProtocolErrorRecoveryIssue({ error: outcome.error, phase, createdAt: nowIso() })
        : buildReviewFailedRecoveryIssue({
            phase,
            detail: `The ${args.source} triage asked a question this run has no way to answer.`,
            createdAt: nowIso(),
          });
  publishError({ bus: wctx.bus, phase, message: issue.message });
  return raisePendingRecovery(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId, bus: wctx.bus },
    state,
    issue,
    args.setTrackedState,
  );
}

/** Triaged fix work spends one fix cycle; appended tasks announce it. */
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
