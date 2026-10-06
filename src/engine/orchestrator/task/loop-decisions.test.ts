import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering } from '#testing/helpers/typed-planner.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { error } from '../../../utils/error.js';
import { loadState } from '../../../core/state/persistence.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { Task } from '../../../core/schemas/task.js';
import type { LineageRecord, WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import type { RunValidationOptions, Validator } from '../validation/types.js';
import type { ValidationResult } from '../validation/result.js';
import { createValidator } from '../validation/run.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { runTaskLoop } from './loop.js';

type Decision = { what: string; why: string };

const HOW: Decision = {
  what: 'Imported ReviewRecord from schemas/workflow.ts',
  why: 'The brief named a module that does not export it',
};
const HOW_TOO: Decision = {
  what: 'Kept the helper private to the module',
  why: 'Only one caller reads it',
};
const WHAT: Decision = { what: 'Dropped the --json flag', why: 'It was hard to wire' };
const ANSWER = 'Keep the --json flag and wire it.';
const TS_ERROR =
  "src/engine/orchestrator/task/loop.ts(5,15): error TS2305: Module '../../../core/schemas/review.js' has no exported member 'ReviewRecord'.";
const LINT_ERROR =
  'loop-batch-boundary.test.ts:224 Formatter would have printed different content.';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-decisions',
    sessionId: 'sess-loop-decisions',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function lineage(overrides: Partial<LineageRecord>): LineageRecord {
  return {
    consults: 0,
    attempts: 0,
    consultAllowance: 2,
    attemptAllowance: 8,
    staleConsultedRevision: {},
    consultRecords: [],
    replacedParents: [],
    notes: [],
    ...overrides,
  };
}

function stateWithPlan(tasks: Task[], overrides?: Partial<WorkflowState>): WorkflowState {
  return makeImplState(tasks, {
    plan: {
      summary: 'Finish the review pipeline.',
      decisions: [],
      criteria: [],
      checks: [],
      validation: null,
    },
    ...overrides,
  });
}

function doneReport(decisions: readonly Decision[], file: string) {
  return {
    status: 'done' as const,
    filesChanged: [file],
    touchedNotSuggested: [],
    notes: null,
    decisions: [...decisions],
  };
}

/** An implementer that writes the brief's file and hands back the decisions each call reports. */
function decidingImplementer(decisionsPerCall: readonly (readonly Decision[])[]) {
  const script = [...decisionsPerCall];
  const write = (projectDir: string, task: Task, marker: string) => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, task.suggestedFiles[0]), `${marker}\n`);
  };
  const handBack = (decisions: readonly Decision[], task: Task) => ({
    success: true,
    output: 'implemented',
    usage: { inputTokens: 10, outputTokens: 5 },
    report: doneReport(decisions, task.suggestedFiles[0]),
  });
  let calls = 0;
  return makeImplementer({
    implement: vi.fn(async (opts: ImplementerOptions) => {
      calls += 1;
      write(opts.projectDir, opts.task, `implement ${calls}`);
      return handBack(script.shift() ?? [], opts.task);
    }),
    retry: vi.fn(async (opts: RetryOptions) => {
      calls += 1;
      write(opts.projectDir, opts.task, `retry ${calls}`);
      return handBack(script.shift() ?? [], opts.task);
    }),
  });
}

/** A validator whose calls answer from a script per task; past the script every call passes. */
function scriptedValidator(script: Record<string, readonly (string | null)[]>): Validator {
  const queues = new Map(Object.entries(script).map(([id, answers]) => [id, [...answers]]));
  const runValidation = vi.fn(async (opts: RunValidationOptions): Promise<ValidationResult[]> => {
    const error = queues.get(opts.task.id)?.shift() ?? null;
    return error === null
      ? [{ stage: 'typecheck', passed: true }]
      : [{ stage: 'typecheck', passed: false, error }];
  });
  return { ...createValidator(), runValidation };
}

function confirm(decisions: readonly Decision[]): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'A change of how; every criterion stays.',
      action: 'confirm',
      decisions: [...decisions],
    },
  };
}

function askUser(): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'Dropping the flag changes what is built.',
      action: 'ask-user',
      question: 'Keep the --json flag?',
      whyOnlyUserCanAnswer: 'It changes the accepted outcome.',
      choices: null,
      default: null,
    },
  };
}

function guidance(): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'The import is still wrong.',
      action: 'guidance',
      instructions: 'Import ReviewRecord from src/core/schemas/workflow.ts.',
      context: null,
    },
  };
}

/** The planner's prompts, and an answer per kind: decision-confirm prompts carry the deviation reason. */
function scriptedPlanner(answers: { confirm: () => ConsultAnswer; consult?: () => ConsultAnswer }) {
  const prompts: string[] = [];
  const planner = makePlanner({
    typedCall: consultCallAnswering((prompt) => {
      prompts.push(prompt);
      if (prompt.includes('deviation —')) return answers.confirm();
      if (answers.consult === undefined) throw new Error('the ladder consulted the planner');
      return answers.consult();
    }),
  });
  return { planner, prompts };
}

function isDecisionConfirm(prompt: string): boolean {
  return prompt.includes('deviation —');
}

function eventTypes(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'consult_answered') return [`consult:${event.reason}:${event.action}`];
    if (event.type === 'task_retry') return ['retry'];
    if (event.type === 'consult_bound_spent') return ['bound-spent'];
    return [];
  });
}

async function runLoop(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  implementer: ReturnType<typeof makeImplementer>;
  validator: Validator;
  planner: ReturnType<typeof makePlanner>;
  callbacks?: ReturnType<typeof makeCallbacks>['callbacks'];
  bus: ReturnType<typeof makeBusRecorder>['bus'];
  signal?: AbortSignal;
}) {
  const wctx = await openRunWorkspace(
    makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      config: makeNoValidationConfig(),
      callbacks: opts.callbacks ?? makeCallbacks({ onPlannerReply: vi.fn() }).callbacks,
      planner: opts.planner,
      implementer: opts.implementer,
      validator: opts.validator,
      bus: opts.bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
  );
  return runTaskLoop({
    wctx,
    initialState: opts.state,
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
}

describe('runTaskLoop with reported decisions', { timeout: 90_000 }, () => {
  it('confirms how-only decisions, then a red validation retries with the exact errors before any consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW], [HOW], [HOW]]);
    const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
    const { planner, prompts } = scriptedPlanner({
      confirm: () => confirm([HOW]),
      consult: guidance,
    });
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      // The stale consult already spent one of the lineage's two consults, as in the S6 run.
      state: stateWithPlan([task], { lineages: { T001: lineage({ consults: 1 }) } }),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');
    expect(eventTypes(events)).toEqual([
      'consult:deviation:confirm',
      'retry',
      'consult:failed:guidance',
    ]);

    // The local retry carried the exact failing output; the consult got the retry's own errors.
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries[0]?.kind).toBe('local');
    expect(retries[0]?.error).toContain(TS_ERROR);
    expect(retries[1]?.kind).toBe('consult');
    const consults = prompts.filter((prompt) => !isDecisionConfirm(prompt));
    expect(consults).toHaveLength(1);
    expect(consults[0]).toContain('failed —');
    expect(consults[0]).toContain(LINT_ERROR);

    // The retries handed back the same decision: confirmed once, recorded once.
    expect(prompts.filter(isDecisionConfirm)).toHaveLength(1);
    expect(result.state.plan?.decisions).toEqual([
      { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
    ]);

    expect(result.state.lineages?.T001).toMatchObject({ consults: 2 });
    expect(result.state.plannerCalls?.used).toBe(1);
  });

  it('confirms only the decisions the ledger does not hold yet', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW], [HOW, HOW_TOO]]);
    const validator = scriptedValidator({ T001: [TS_ERROR, null] });
    const confirmations = [[HOW], [HOW_TOO]];
    const { planner, prompts } = scriptedPlanner({
      confirm: () => confirm(confirmations.shift() ?? []),
    });
    const { bus } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.status).toBe('complete');
    const asked = prompts.filter(isDecisionConfirm);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(HOW_TOO.what);
    expect(asked[1]).not.toContain(`Decisions: ${HOW.what}`);
    expect(result.state.plan?.decisions).toEqual([
      { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
      { text: `${HOW_TOO.what} — ${HOW_TOO.why}`, taskId: 'T001' },
    ]);
    expect(result.state.plannerCalls?.used ?? 0).toBe(0);
  });

  it('confirms decisions with the consult and planner-call bounds spent, and never halts', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW, HOW_TOO]]);
    const validator = scriptedValidator({});
    const { planner, prompts } = scriptedPlanner({ confirm: () => confirm([HOW, HOW_TOO]) });
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task], {
        lineages: { T001: lineage({ consults: 2 }) },
        plannerCalls: { used: 10, allowance: 10 },
      }),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');
    expect(prompts).toHaveLength(1);
    expect(eventTypes(events)).toEqual(['consult:deviation:confirm']);
    expect(events.some((event) => event.type === 'task_escalating')).toBe(false);
    expect(result.state.lineages?.T001?.consults).toBe(2);
    expect(result.state.plannerCalls).toEqual({ used: 10, allowance: 10 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'consult_answered',
        taskId: 'T001',
        reason: 'deviation',
        action: 'confirm',
        decisionCount: 2,
      }),
    );
  });

  it('puts a change of what to the user and delivers the answer, without a retry row or a consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[WHAT], []]);
    const validator = scriptedValidator({});
    const { planner, prompts } = scriptedPlanner({ confirm: askUser });
    const onPlannerReply = vi.fn().mockResolvedValue(ANSWER);
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      bus,
    });

    expect(result.status).toBe('complete');
    expect(onPlannerReply).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.error).toContain(ANSWER);
    // The answer is delivered outside the retry rung: the ask-user row records it, no task_retry.
    expect(eventTypes(events)).toEqual(['consult:deviation:ask-user']);
    expect(result.state.plan?.decisions).toEqual([]);
    expect(result.state.plannerCalls?.used ?? 0).toBe(0);
  });

  it('delivers the answer outside the retry rung, so a red validation after it still retries with the exact errors before any consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    // The attempt reports a change of what; the answered attempt reports a change of how and
    // fails typecheck; the one local retry passes. This is T005 of the S11 run.
    const implementer = decidingImplementer([[WHAT], [HOW], [HOW]]);
    const validator = scriptedValidator({ T001: [TS_ERROR, null] });
    const confirms = [askUser, () => confirm([HOW])];
    const { planner, prompts } = scriptedPlanner({
      confirm: () => (confirms.shift() ?? askUser)(),
    });
    const onPlannerReply = vi.fn().mockResolvedValue(ANSWER);
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      bus,
    });

    expect(eventTypes(events)).toEqual([
      'consult:deviation:ask-user',
      'consult:deviation:confirm',
      'retry',
    ]);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');
    const retryRows = events.filter((event) => event.type === 'task_retry');
    expect(retryRows).toHaveLength(1);
    expect(retryRows[0]).toMatchObject({ attempt: 1, maxRetries: 1 });
    expect(retryRows[0]).toMatchObject({ error: expect.stringContaining(TS_ERROR) });
    expect(events.some((event) => event.type === 'task_escalating')).toBe(false);

    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries).toHaveLength(2);
    expect(retries[0]?.error).toContain(ANSWER);
    expect(retries[1]?.kind).toBe('local');
    expect(retries[1]?.error).toContain(TS_ERROR);
    expect(prompts.filter((prompt) => !isDecisionConfirm(prompt))).toEqual([]);
    expect(result.state.lineages?.T001?.consults ?? 0).toBe(0);
    // The attempt, the delivery and the retry each count against the lineage.
    expect(result.state.lineages?.T001?.attempts).toBe(3);
  });

  it('delivers the answer to an attempt the consult guided without a second consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    // Red, red after the local retry, one consult; its attempt reports a change of what, and the
    // answered attempt passes. The answer spends neither a consult nor the consult's attempt.
    const implementer = decidingImplementer([[], [], [WHAT], []]);
    const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
    const consults = [guidance];
    const { planner, prompts } = scriptedPlanner({
      confirm: askUser,
      consult: () => {
        const next = consults.shift();
        if (next === undefined) throw new Error('the ladder consulted the planner twice');
        return next();
      },
    });
    const onPlannerReply = vi.fn().mockResolvedValue(ANSWER);
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      bus,
    });

    expect(eventTypes(events)).toEqual([
      'retry',
      'consult:failed:guidance',
      'consult:deviation:ask-user',
    ]);
    expect(prompts.filter((prompt) => !isDecisionConfirm(prompt))).toHaveLength(1);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries).toHaveLength(3);
    expect(retries[2]?.error).toContain(ANSWER);
    expect(result.state.lineages?.T001?.consults).toBe(1);
  });

  it('halts an answer that arrives with the attempt allowance spent, quoting the answer and not the consult that preceded it', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    // Five attempts are spent already. The attempt, the local retry and the consult-guided attempt
    // take the lineage to its eighth; that attempt reports a change of what, so the delivery
    // would be the ninth.
    const implementer = decidingImplementer([[], [], [WHAT], []]);
    const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
    const { planner, prompts } = scriptedPlanner({ confirm: askUser, consult: guidance });
    const onPlannerReply = vi.fn().mockResolvedValue(ANSWER);
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task], { lineages: { T001: lineage({ attempts: 5 }) } }),
      implementer,
      validator,
      planner,
      callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      bus,
    });

    expect(eventTypes(events)).toEqual([
      'retry',
      'consult:failed:guidance',
      'consult:deviation:ask-user',
      'bound-spent',
    ]);
    expect(prompts.filter((prompt) => !isDecisionConfirm(prompt))).toHaveLength(1);
    expect(vi.mocked(implementer.retry)).toHaveBeenCalledTimes(2);
    expect(result.state.lineages?.T001).toMatchObject({ attempts: 8, consults: 1 });
    expect(result.state.pendingRecovery).toMatchObject({ reason: 'consult-bound-spent' });
    const lastDiagnosis = result.state.pendingRecovery?.facts?.lastDiagnosis;
    expect(lastDiagnosis).toContain(ANSWER);
    expect(lastDiagnosis).not.toContain('The import is still wrong.');
  });

  it("confirms a brief's decisions however many confirms the briefs before it spent", async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW]]);
    const validator = scriptedValidator({});
    const { planner, prompts } = scriptedPlanner({ confirm: () => confirm([HOW]) });
    const { bus, events } = makeBusRecorder();

    // An older session saved the retired run-wide counter as spent; it no longer bounds a brief.
    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task], {
        decisionConfirms: { used: 20, allowance: 20 },
      } as Partial<WorkflowState>),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.status).toBe('complete');
    expect(prompts.filter(isDecisionConfirm)).toHaveLength(1);
    expect(result.state.plan?.decisions).toEqual([
      { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('allowance') }),
    );
  });

  it('asks the user about a change of what a retry reported, and delivers the answer without a consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[], [WHAT], []]);
    const validator = scriptedValidator({ T001: [TS_ERROR, null] });
    const { planner, prompts } = scriptedPlanner({ confirm: askUser });
    const onPlannerReply = vi.fn().mockResolvedValue(ANSWER);
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      bus,
    });

    expect(eventTypes(events)).toEqual(['retry', 'consult:deviation:ask-user']);
    expect(prompts.filter((prompt) => !isDecisionConfirm(prompt))).toEqual([]);
    expect(result.status).toBe('complete');
    expect(onPlannerReply).toHaveBeenCalledTimes(1);
    // The attempt that reported the change of what was not validated.
    expect(validator.runValidation).toHaveBeenCalledTimes(2);
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries).toHaveLength(2);
    expect(retries[1]?.error).toContain(ANSWER);
    expect(result.state.plan?.decisions).toEqual([]);
    expect(result.state.lineages?.T001?.consults ?? 0).toBe(0);
  });

  it('validates with a warning when the decision-confirm answer is malformed', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW]]);
    const validator = scriptedValidator({});
    const planner = makePlanner({
      typedCall: (ctx) => ({
        seat: ctx.seat,
        typedOutput: 'fallback',
        canResume: false,
        invoke: async () => makeRunnerCallResult({ status: 'completed', text: '{}' }),
      }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');
    expect(validator.runValidation).toHaveBeenCalledTimes(1);
    expect(result.state.plan?.decisions).toEqual([]);
    expect(result.state.plannerCalls?.used ?? 0).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('T001') }),
    );
  });

  it('halts on a recovery when the decision-confirm call itself fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW]]);
    const validator = scriptedValidator({});
    const planner = makePlanner({
      typedCall: consultCallAnswering(() => {
        throw error('runner-call-failed', 'Planner escalation call failed', {
          role: 'escalation',
          status: 'failed',
          error: { code: 'turn-failed', message: 'The planner process crashed.' },
        });
      }),
    });
    const { bus } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.state.pendingRecovery).toMatchObject({ taskId: 'T001' });
    expect(validator.runValidation).not.toHaveBeenCalled();
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeDefined();
    // The implementer attempt behind the failed confirmation still counts on the lineage.
    expect(result.state.lineages?.T001?.attempts).toBe(1);
  });

  it('stops without validation or a recovery when the run is stopped during the decision-confirm', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW]]);
    const validator = scriptedValidator({});
    const controller = new AbortController();
    const planner = makePlanner({
      typedCall: consultCallAnswering(() => {
        controller.abort();
        throw error('operation-aborted', 'Operation aborted');
      }),
    });
    const { bus } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
      signal: controller.signal,
    });

    expect(result.status).not.toBe('complete');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(validator.runValidation).not.toHaveBeenCalled();
    expect(result.state.plan?.decisions).toEqual([]);
    expect(result.state.tasks[0]?.status).not.toBe('done');
  });

  it.each([
    ['consult-bound-spent', { lineages: { T001: lineage({ consults: 2 }) } }],
    ['planner-calls-spent', { plannerCalls: { used: 10, allowance: 10 } }],
  ] as const)(
    'restarts a brief continued past %s with the last failing output',
    async (reason, bounds) => {
      const { projectDir, sessionId } = setupProject();
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
      const implementer = decidingImplementer([]);
      const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
      const { planner } = scriptedPlanner({ confirm: () => confirm([]) });
      const { bus, events } = makeBusRecorder();

      const halted = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task], bounds),
        implementer,
        validator,
        planner,
        bus,
      });
      expect(halted.state.pendingRecovery?.reason).toBe(reason);
      expect(eventTypes(events)).toEqual(['retry', 'bound-spent']);

      const applied = await applyRecoveryAction({
        projectDir,
        sessionId,
        state: halted.state,
        action: 'continue',
        bus,
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.state.lineages?.T001?.carriedFailure).toContain(LINT_ERROR);

      const resumed = await runLoop({
        projectDir,
        sessionId,
        state: applied.state,
        implementer,
        validator,
        planner,
        bus,
      });

      expect(resumed.state.pendingRecovery).toBeUndefined();
      expect(resumed.status).toBe('complete');
      // The restart is a retry carrying the last failing output, never a bare re-implement.
      expect(implementer.implement).toHaveBeenCalledTimes(1);
      const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
      expect(retries).toHaveLength(2);
      expect(retries[0]?.error).toContain(TS_ERROR);
      expect(retries[1]?.error).toContain(LINT_ERROR);
      expect(resumed.state.lineages?.T001?.carriedFailure).toBeUndefined();
    },
  );

  it('keeps the carried failure across a stop, and drops it once the carrying attempt returns', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const validator = scriptedValidator({ T001: [LINT_ERROR] });
    const { planner } = scriptedPlanner({ confirm: () => confirm([]), consult: guidance });
    const { bus } = makeBusRecorder();
    const controller = new AbortController();
    const stopping = makeImplementer({
      retry: vi.fn(async () => {
        controller.abort();
        return { success: false, output: '', outcome: 'user-abort' as const, error: 'Aborted' };
      }),
    });
    const carried = stateWithPlan([task], {
      lineages: { T001: lineage({ consults: 2, carriedFailure: LINT_ERROR }) },
    });

    const stopped = await runLoop({
      projectDir,
      sessionId,
      state: carried,
      implementer: stopping,
      validator,
      planner,
      bus,
      signal: controller.signal,
    });
    expect(vi.mocked(stopping.retry).mock.calls[0]?.[0].error).toContain(LINT_ERROR);
    expect(stopped.state.lineages?.T001?.carriedFailure).toBe(LINT_ERROR);

    // The resumed attempt still carries it; it fails validation once, and the
    // ladder's own retry no longer replays the carried text.
    const implementer = decidingImplementer([]);
    const resumed = await runLoop({
      projectDir,
      sessionId,
      state: stopped.state,
      implementer,
      validator: scriptedValidator({ T001: [TS_ERROR, null] }),
      planner,
      bus,
    });
    expect(resumed.status).toBe('complete');
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries[0]?.error).toContain(LINT_ERROR);
    expect(retries[1]?.error).toContain(TS_ERROR);
    expect(retries[1]?.error).not.toContain(LINT_ERROR);
    expect(resumed.state.lineages?.T001?.carriedFailure).toBeUndefined();
  });
});
