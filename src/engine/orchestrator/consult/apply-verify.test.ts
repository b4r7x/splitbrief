import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type { PlannerConversation, WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlannerReplyAnswer } from '../../../core/schemas/question.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { saveState } from '../../../core/state/persistence.js';
import { processError } from '../../../lib/process/errors.js';
import type { EngineEvent } from '../../events/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeBusRecorder,
  makeCallbacks,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import type { ValidationResult } from '../validation/result.js';
import type { ValidationCommandRunner, Validator } from '../validation/types.js';
import { applyConsultAnswer, type ConsultApplyContext } from './apply.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setupRepo(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('consult-apply-verify');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, { 'src/greet.ts': 'export const greet = "base";\n' });
  const sessionId = 'sess-consult-apply-verify';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function planWith(checks: Check[], checkIds: string[] = ['K1']): Plan {
  return {
    summary: 'Fix the greeting',
    decisions: [],
    criteria: [{ id: 'C1', text: 'The greeting is returned', checkIds }],
    checks,
    validation: null,
  };
}

function verify(checkIds: string[], reason: string): ConsultAnswer {
  return {
    answer: { diagnosis: 'The check may predate the task', action: 'verify', checkIds, reason },
  };
}

function askUser(defaultAnswer: string | null): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'Only the user knows',
      action: 'ask-user',
      question: 'Which store?',
      whyOnlyUserCanAnswer: 'It changes the deployment',
      choices: ['redis', 'memory'],
      default: defaultAnswer,
    },
  };
}

function fakeValidator(opts?: { results?: ValidationResult[]; accepted?: boolean }): Validator {
  const results = opts?.results ?? [{ stage: 'test' as const, passed: true }];
  const accepted = opts?.accepted ?? true;
  return {
    primeBaseline: vi.fn().mockResolvedValue(undefined),
    runFullSuite: vi
      .fn()
      .mockResolvedValue({ results: [], failures: {}, newFailures: {}, stages: {} }),
    runValidation: vi.fn().mockResolvedValue(results),
    decideAcceptance: vi.fn().mockReturnValue({
      accepted,
      exemptStages: [],
      blockingStages: accepted ? [] : ['test'],
    }),
  };
}

type Harness = {
  ctx: ConsultApplyContext;
  states: WorkflowState[];
  events: EngineEvent[];
  validator: Validator;
};

function harness(opts: {
  projectDir: string;
  sessionId: string;
  task: Task;
  plan: Plan;
  validator?: Validator;
  runCommand?: ValidationCommandRunner;
  onPlannerReply?:
    | ((reply: PlannerConversation) => Promise<string | PlannerReplyAnswer | undefined>)
    | undefined;
  changedFiles?: string[];
}): Harness {
  const state: WorkflowState = {
    ...makeImplState([opts.task], { plan: opts.plan }),
    phase: 'escalating',
    attempt: 1,
  };
  saveState({ projectDir: opts.projectDir, sessionId: opts.sessionId }, state);
  const { bus, events } = makeBusRecorder();
  const states: WorkflowState[] = [];
  const validator = opts.validator ?? fakeValidator();
  const callbacks = makeCallbacks(
    opts.onPlannerReply === undefined ? undefined : { onPlannerReply: opts.onPlannerReply },
  ).callbacks;
  return {
    ctx: {
      taskStartTime: Date.now(),
      projectDir: opts.projectDir,
      workspaceDir: opts.projectDir,
      sessionId: opts.sessionId,
      bus,
      config: makeConfig({}),
      validator,
      callbacks,
      sinks: TEST_SINKS,
      state,
      changedFiles: opts.changedFiles ?? [],
      ...(opts.runCommand !== undefined && { runCommand: opts.runCommand }),
      onStateChange: (next) => states.push(next),
    },
    states,
    events,
    validator,
  };
}

describe('applyConsultAnswer verify', () => {
  it('runs the validation and the selected checks and completes the task as consulted', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const commandRunner = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const { ctx, states, events, validator } = harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: commandRunner,
      changedFiles: ['src/greet.ts'],
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      verify(['K1'], 'The check may predate the task'),
      attempt,
    );

    expect(result).toEqual({
      action: 'completed',
      task: expect.objectContaining({ id: 'T003', status: 'done' }),
      durationMs: expect.any(Number),
    });
    expect(validator.runValidation).toHaveBeenCalledWith(
      expect.objectContaining({ task, phase: 'escalating', changedFiles: ['src/greet.ts'] }),
    );
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      { taskId: 'T003', results: [{ id: 'K1', passed: true }] },
    ]);
    expect(events.filter((event) => event.type === 'task_completed')).toMatchObject([
      { taskId: 'T003', method: 'consulted' },
    ]);
    const saved = states.at(-1);
    expect(saved?.tasks[0]?.status).toBe('done');
    expect(saved?.tasks[0]?.checkResults).toEqual([{ id: 'K1', passed: true }]);
  });

  it('books the time since the brief started on the completion it publishes', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const { ctx, events } = harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 }),
      changedFiles: ['src/greet.ts'],
    });
    const attempt = await getChangedFilesSnapshot(projectDir);
    const taskStartTime = Date.now();
    const started = { ...ctx, taskStartTime };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(taskStartTime + 5_000);
    try {
      await applyConsultAnswer(
        started,
        task,
        verify(['K1'], 'The check predates the task'),
        attempt,
      );
    } finally {
      clock.mockRestore();
    }

    expect(events.filter((event) => event.type === 'task_completed')).toMatchObject([
      { taskId: 'T003', method: 'consulted', duration: 5_000 },
    ]);
  });

  it('fails the consult on an empty selection without running anything', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const { ctx, states, events, validator } = harness({ projectDir, sessionId, task, plan });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify([], 'Nothing to check'), attempt);

    expect(result).toEqual({ action: 'failed', reason: 'the verify selection names no check' });
    expect(validator.runValidation).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  it('fails the consult on a selection naming an unknown check', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const { ctx, events, validator } = harness({ projectDir, sessionId, task, plan });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify(['K9'], 'Check K9'), attempt);

    expect(result).toMatchObject({ action: 'failed', reason: expect.stringContaining('K9') });
    expect(validator.runValidation).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("fails the consult when the selection misses a criterion's check", async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith(
      [
        { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true },
        { id: 'K2', kind: 'cmd', value: 'biome check', required: true },
      ],
      ['K1', 'K2'],
    );
    const { ctx, events, validator } = harness({ projectDir, sessionId, task, plan });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify(['K1'], 'Only one check'), attempt);

    expect(result).toMatchObject({ action: 'failed', reason: expect.stringContaining('K2') });
    expect(validator.runValidation).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('records the checks but fails the consult when the validation is not accepted', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const commandRunner = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const validator = fakeValidator({
      results: [{ stage: 'test' as const, passed: false, error: 'boom' }],
      accepted: false,
    });
    const { ctx, states, events } = harness({
      projectDir,
      sessionId,
      task,
      plan,
      validator,
      runCommand: commandRunner,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify(['K1'], 'Verify K1'), attempt);

    expect(result).toMatchObject({ action: 'failed', reason: expect.stringContaining('boom') });
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      { taskId: 'T003', results: [{ id: 'K1', passed: true }] },
    ]);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(0);
    expect(states.at(-1)?.tasks[0]?.status).toBe('failed');
  });

  it('records a failing check and fails the consult without completing the task', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const commandRunner = makeCommandRunner(
      processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' }),
    );
    const { ctx, states, events } = harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: commandRunner,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify(['K1'], 'Verify K1'), attempt);

    expect(result).toMatchObject({
      action: 'failed',
      reason: expect.stringContaining('K1'),
    });
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      { taskId: 'T003', results: [{ id: 'K1', passed: false }] },
    ]);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(0);
    expect(states.at(-1)?.tasks[0]?.status).toBe('failed');
  });

  it('runs the remaining task checks once and records the consult runs with them', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
      checks: [
        { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true },
        { id: 'K2', kind: 'cmd', value: 'node --version', required: true },
      ],
    });
    const plan = planWith([], ['K1']);
    const commandRunner = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const { ctx, states, events } = harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: commandRunner,
      changedFiles: ['src/greet.ts'],
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      verify(['K1'], 'Only K1 has not run'),
      attempt,
    );

    expect(result).toMatchObject({ action: 'completed' });
    expect(commandRunner.calls).toHaveLength(1);
    expect(commandRunner.calls[0]?.cmd).toBe('tsc');
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      {
        taskId: 'T003',
        results: [
          { id: 'K1', passed: true },
          { id: 'K2', passed: true },
        ],
      },
    ]);
    expect(states.at(-1)?.tasks[0]?.checkResults).toEqual([
      { id: 'K1', passed: true },
      { id: 'K2', passed: true },
    ]);
    const checks = readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.checks ?? [];
    expect(checks.filter((entry) => entry.id === 'K1')).toHaveLength(1);
    expect(checks.filter((entry) => entry.id === 'K2')).toHaveLength(1);
  });
});

describe('applyConsultAnswer ask-user', () => {
  it('puts the one question to the operator and hands the answer back as guidance', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([]);
    const replies: PlannerConversation[] = [];
    const { ctx, states } = harness({
      projectDir,
      sessionId,
      task,
      plan,
      onPlannerReply: async (reply) => {
        replies.push(reply);
        return 'redis';
      },
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, askUser('memory'), attempt);

    expect(result).toEqual({ action: 'guidance', instructions: 'redis', context: null });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.questions).toMatchObject([
      {
        type: 'choice',
        text: 'Which store?',
        options: ['redis', 'memory'],
        default: 'memory',
      },
    ]);
    expect(states.at(-1)?.phase).toBe('escalating');
    expect(states.at(-1)?.pendingPlannerConversation).toBeUndefined();
    expect(states.at(-1)?.userAnswers).toEqual([{ reply: 'Which store?', answer: 'redis' }]);
  });

  it('takes the default when the operator answers with a bare Enter', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([]);
    const { ctx } = harness({
      projectDir,
      sessionId,
      task,
      plan,
      onPlannerReply: async () => '',
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, askUser('memory'), attempt);

    expect(result).toEqual({ action: 'guidance', instructions: 'memory', context: null });
  });

  it('takes the default when the run is headless', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([]);
    const { ctx, states } = harness({ projectDir, sessionId, task, plan });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, askUser('memory'), attempt);

    expect(result).toEqual({ action: 'guidance', instructions: 'memory', context: null });
    expect(states.at(-1)?.phase).toBe('escalating');
    expect(states.at(-1)?.userAnswers).toEqual([{ reply: 'Which store?', answer: 'memory' }]);
  });
});
