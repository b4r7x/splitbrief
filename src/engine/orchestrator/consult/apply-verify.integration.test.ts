import { plainUserMessage } from '../../../core/types/user-input.js';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type {
  ChangedFilesSnapshot,
  PlannerConversation,
  WorkflowState,
} from '../../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from '../types.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { readReviewChanges } from '../../../core/evidence/review-changes.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { appendEngineEvent } from '../../../core/sessions/log-writer.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
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
import { enqueueUserMessage } from '../queue/submit.js';
import { CORRECTION_AFTER_CHECKS } from '../task/brief-gate.js';
import type { ValidationCommandRunner, Validator } from '../validation/types.js';
import { applyConsultAnswer, type ConsultApplyContext } from './apply.js';
import { restoreInterruptedTaskFiles } from '../task/rollback.js';

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

function fakeValidator(): Validator {
  return { formatChangedFiles: vi.fn().mockResolvedValue(undefined) };
}

type Harness = {
  ctx: ConsultApplyContext;
  states: WorkflowState[];
  events: EngineEvent[];
  validator: Validator;
};

async function harness(opts: {
  projectDir: string;
  sessionId: string;
  task: Task;
  plan: Plan;
  otherTasks?: Task[];
  validator?: Validator;
  runCommand?: ValidationCommandRunner;
  onPlannerReply?: OrchestratorCallbacks['onPlannerReply'];
  changedFiles?: string[];
  taskStartSnapshot?: ChangedFilesSnapshot;
}): Promise<Harness> {
  const otherTasks = opts.otherTasks ?? [];
  const state: WorkflowState = {
    ...makeImplState([...otherTasks, opts.task], {
      plan: opts.plan,
      currentTaskIndex: otherTasks.length,
    }),
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
      projectDir: opts.projectDir,
      workspaceDir: opts.projectDir,
      sessionId: opts.sessionId,
      bus,
      config: { ...makeConfig({}), workflow: { review: 'task', compactionFormat: 'auto' } },
      validator,
      callbacks,
      sinks: TEST_SINKS,
      state,
      seat: 'plan',
      changedFiles: opts.changedFiles ?? [],
      taskStartSnapshot: opts.taskStartSnapshot ?? (await getChangedFilesSnapshot(opts.projectDir)),
      ...(opts.runCommand !== undefined && { runCommand: opts.runCommand }),
      onStateChange: (next) => states.push(next),
    },
    states,
    events,
    validator,
  };
}

describe('applyConsultAnswer verify', () => {
  it('keeps the task baseline when verification records writes against a later attempt', async () => {
    const ref = setupRepo();
    const checks: Check[] = [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }];
    const task = makeTask({ id: 'T003', status: 'in_progress', criteria: ['C1'], checks });
    const taskStartSnapshot = {
      ...(await getChangedFilesSnapshot(ref.projectDir)),
      restoreFiles: ['src/greet.ts'],
    };
    writeFileSync(join(ref.projectDir, 'src/greet.ts'), 'first attempt\n');
    const attemptSnapshot = await getChangedFilesSnapshot(ref.projectDir);
    writeFileSync(join(ref.projectDir, 'src/greet.ts'), 'retry attempt\n');
    const { ctx } = await harness({
      ...ref,
      task,
      plan: planWith(checks),
      runCommand: async () => {
        writeFileSync(join(ref.projectDir, 'generated.txt'), 'check output\n');
        throw processError.exitCode({ command: 'node', code: 1, stderr: 'check failed' });
      },
    });
    const state = {
      ...ctx.state,
      changedFilesBaseline: {
        head: taskStartSnapshot.head,
        fingerprints: {},
        activeTaskSnapshot: taskStartSnapshot,
      },
    };
    saveState(ref, state);

    const result = await applyConsultAnswer(
      { ...ctx, state },
      task,
      verify(['K1'], 'Run the check again'),
      attemptSnapshot,
    );

    expect(result.action).toBe('failed');
    await restoreInterruptedTaskFiles({
      wctx: ctx,
      phase: state.phase,
      task,
      taskStartSnapshot,
    });
    expect(readFileSync(join(ref.projectDir, 'src/greet.ts'), 'utf8')).toBe(
      'export const greet = "base";\n',
    );
    expect(existsSync(join(ref.projectDir, 'generated.txt'))).toBe(false);
  });

  it('returns a correction without completing when a message arrives during green verify checks', async () => {
    const ref = setupRepo();
    const checks: Check[] = [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }];
    const task = makeTask({ id: 'T003', status: 'in_progress', criteria: ['C1'], checks });
    const { ctx, states, events } = await harness({
      ...ref,
      task,
      plan: planWith(checks),
      runCommand: async () => {
        const state = loadState(ref);
        if (state === null) throw new Error('missing state during verify checks');
        enqueueUserMessage({
          ...ref,
          state,
          message: plainUserMessage('keep the alias'),
          phase: state.phase,
          bus: ctx.bus,
        });
        return { stdout: 'ok', stderr: '', code: 0 };
      },
    });

    const result = await applyConsultAnswer(
      ctx,
      task,
      verify(['K1'], 'Verify K1'),
      await getChangedFilesSnapshot(ref.projectDir),
    );

    expect(result).toEqual({ action: 'correction', answer: CORRECTION_AFTER_CHECKS });
    expect(states.at(-1)?.messageQueue[0]?.text).toBe('keep the alias');
    expect(loadState(ref)?.tasks[0]?.status).toBe('in_progress');
    expect(loadState(ref)?.currentTaskIndex).toBe(0);
    expect(loadState(ref)?.messageQueue[0]?.deliveredTo).toBeUndefined();
    expect(events.filter((event) => event.type === 'task_completed')).toEqual([]);
  });

  it('formats the changed files, runs the selected checks and completes the task as consulted', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const commandRunner = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const { ctx, states, events, validator } = await harness({
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
      bookedFiles: [],
    });
    expect(validator.formatChangedFiles).toHaveBeenCalledWith(
      expect.objectContaining({ task, phase: 'escalating', changedFiles: ['src/greet.ts'] }),
    );
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      { taskId: 'T003', results: [{ id: 'K1', status: 'pass' }] },
    ]);
    expect(events.filter((event) => event.type === 'task_completed')).toMatchObject([
      { taskId: 'T003', method: 'consulted' },
    ]);
    const saved = states.at(-1);
    expect(saved?.tasks[0]?.status).toBe('done');
    expect(saved?.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
  });

  it("records the brief's files since its task start when verify completes it after a retry", async () => {
    const ref = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts', 'src/added.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const taskStartSnapshot = await getChangedFilesSnapshot(ref.projectDir);
    writeFileSync(join(ref.projectDir, 'src/greet.ts'), 'export const greet = "done";\n');
    writeFileSync(join(ref.projectDir, 'src/added.ts'), 'export const added = true;\n');
    // The retry before the consult starts after the files landed and changes nothing.
    const attempt = await getChangedFilesSnapshot(ref.projectDir);
    const { ctx } = await harness({
      ...ref,
      task,
      plan: planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]),
      runCommand: makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 }),
      taskStartSnapshot,
    });

    const result = await applyConsultAnswer(ctx, task, verify(['K1'], 'Verify K1'), attempt);

    expect(result.action).toBe('completed');
    expect(
      readReviewChanges(ref)?.changes.map((change) => [change.taskId, change.path, change.kind]),
    ).toEqual([
      ['T003', 'src/added.ts', 'captured'],
      ['T003', 'src/greet.ts', 'captured'],
    ]);
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
    const { ctx, events } = await harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 }),
      changedFiles: ['src/greet.ts'],
    });
    const attempt = await getChangedFilesSnapshot(projectDir);
    const taskStartTime = Date.now();
    appendEngineEvent(
      { projectDir, sessionId },
      { type: 'task_started', ts: taskStartTime, phase: 'implementing', taskId: task.id },
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(taskStartTime + 5_000);
    try {
      await applyConsultAnswer(ctx, task, verify(['K1'], 'The check predates the task'), attempt);
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
    const runner = makeCommandRunner();
    const { ctx, states, events } = await harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: runner,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify([], 'Nothing to check'), attempt);

    expect(result).toEqual({ action: 'failed', reason: 'the verify selection names no check' });
    expect(runner.calls).toEqual([]);
    expect(events.filter((event) => event.type === 'checks_run')).toEqual([]);
    expect(events).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  it('fails the consult on a selection naming an unknown check', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner();
    const { ctx, events } = await harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: runner,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify(['K9'], 'Check K9'), attempt);

    expect(result).toMatchObject({ action: 'failed', reason: expect.stringContaining('K9') });
    expect(runner.calls).toEqual([]);
    expect(events.filter((event) => event.type === 'checks_run')).toEqual([]);
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
    const runner = makeCommandRunner();
    const { ctx, events } = await harness({
      projectDir,
      sessionId,
      task,
      plan,
      runCommand: runner,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify(['K1'], 'Only one check'), attempt);

    expect(result).toMatchObject({ action: 'failed', reason: expect.stringContaining('K2') });
    expect(runner.calls).toEqual([]);
    expect(events.filter((event) => event.type === 'checks_run')).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it("accepts a selection naming another task's check of a shared criterion and runs it", async () => {
    const { projectDir, sessionId } = setupRepo();
    const done = makeTask({
      id: 'T001',
      criteria: ['C1'],
      status: 'done',
      checks: [{ id: 'K5', kind: 'cmd', value: 'biome check', required: true }],
    });
    const task = makeTask({
      id: 'T002',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    const plan = planWith([], ['K1', 'K5']);
    const runner = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const { ctx, states, events } = await harness({
      projectDir,
      sessionId,
      task,
      plan,
      otherTasks: [done],
      runCommand: runner,
      changedFiles: ['src/greet.ts'],
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      verify(['K1', 'K5'], 'Both criterion checks cover the files'),
      attempt,
    );

    expect(result).toMatchObject({ action: 'completed', task: { id: 'T002', status: 'done' } });
    expect(states.at(-1)?.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      {
        taskId: 'T002',
        results: expect.arrayContaining([
          { id: 'K1', status: 'pass' },
          { id: 'K5', status: 'pass' },
        ]),
      },
    ]);
    expect(events.filter((event) => event.type === 'task_completed')).toMatchObject([
      { taskId: 'T002', method: 'consulted' },
    ]);
  });

  it("does not require a pending owner's check of a shared criterion", async () => {
    const { projectDir, sessionId } = setupRepo();
    const pending = makeTask({
      id: 'T002',
      criteria: ['C1'],
      status: 'pending',
      checks: [{ id: 'K2', kind: 'cmd', value: 'test -e src/beta.mjs', required: true }],
    });
    const task = makeTask({
      id: 'T001',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    const plan = planWith([], ['K1', 'K2']);
    const runner = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const { ctx, events } = await harness({
      projectDir,
      sessionId,
      task,
      plan,
      otherTasks: [pending],
      runCommand: runner,
      changedFiles: ['src/greet.ts'],
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      verify(['K1'], 'K2 belongs to T002'),
      attempt,
    );

    expect(result).toMatchObject({ action: 'completed', task: { id: 'T001', status: 'done' } });
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      { taskId: 'T001', results: [{ id: 'K1', status: 'pass' }] },
    ]);
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
    const { ctx, states, events } = await harness({
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
      { taskId: 'T003', results: [{ id: 'K1', status: 'fail' }] },
    ]);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(0);
    expect(states.at(-1)?.tasks[0]?.status).toBe('failed');
  });

  it.each([
    ['the same check', 'K1'],
    ['a reviewer check of the same command', 'V2'],
  ])(
    'completes a fix task whose remaining failure an unfinished sibling fix task also carries under %s',
    async (_name, siblingCheckId) => {
      const { projectDir, sessionId } = setupRepo();
      const own = 'src/greet.ts(1,14): error TS2322: Type number is not assignable to type string.';
      const shared =
        'src/name.ts(2,7): error TS2322: Type number is not assignable to type string.';
      const other =
        'src/other.ts(3,1): error TS2322: Type number is not assignable to type string.';
      const fixOf = (id: string, keys: string[], status: Task['status'], checkId = 'K1') =>
        makeTask({
          id,
          suggestedFiles: ['src/greet.ts'],
          criteria: ['C1'],
          status,
          fix: {
            cycle: 1,
            findings: [
              {
                id: `${id}.P1`,
                text: `Required check ${checkId} did not pass`,
                acceptance: null,
                checkIds: [checkId],
                commands: { [checkId]: 'tsc --noEmit' },
                failureKeys: { [checkId]: keys },
              },
            ],
          },
        });
      const task = fixOf('T023', [own, shared], 'failed');
      const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
      const { ctx, states } = await harness({
        projectDir,
        sessionId,
        task,
        plan,
        otherTasks: [fixOf('T025', [shared], 'pending', siblingCheckId)],
        runCommand: makeCommandRunner(
          processError.exitCode({
            command: 'tsc',
            code: 1,
            stderr: '',
            output: [shared, other].join('\n'),
          }),
        ),
      });
      const attempt = await getChangedFilesSnapshot(projectDir);

      const result = await applyConsultAnswer(ctx, task, verify(['K1'], 'Verify K1'), attempt);

      expect(result).toMatchObject({ action: 'completed' });
      expect(states.at(-1)?.tasks[1]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
    },
  );

  it('completes when only an optional check the planner did not select fails', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
      checks: [
        { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true },
        { id: 'K2', kind: 'cmd', value: 'node --version', required: false },
      ],
    });
    const commandRunner = makeCommandRunner(
      { stdout: 'clean', stderr: '', code: 0 },
      processError.exitCode({ command: 'node', code: 1, stderr: 'optional red', output: '' }),
    );
    const { ctx, events } = await harness({
      projectDir,
      sessionId,
      task,
      plan: planWith([], ['K1']),
      runCommand: commandRunner,
      changedFiles: ['src/greet.ts'],
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, verify(['K1'], 'Verify K1'), attempt);

    expect(result).toMatchObject({ action: 'completed' });
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      {
        taskId: 'T003',
        results: [
          { id: 'K1', status: 'pass' },
          { id: 'K2', status: 'fail' },
        ],
      },
    ]);
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
    const { ctx, states, events } = await harness({
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
    expect(commandRunner.calls).toHaveLength(2);
    expect(commandRunner.calls[0]?.cmd).toBe('tsc');
    expect(events.filter((event) => event.type === 'checks_run')).toMatchObject([
      {
        taskId: 'T003',
        results: [
          { id: 'K1', status: 'pass' },
          { id: 'K2', status: 'pass' },
        ],
      },
    ]);
    expect(states.at(-1)?.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'pass' },
    ]);
    const checks = readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.checks ?? [];
    expect(checks.filter((entry) => entry.id === 'K1')).toHaveLength(1);
    expect(checks.filter((entry) => entry.id === 'K2')).toHaveLength(1);
  });
});

describe('applyConsultAnswer verify under a pre_validation hook', () => {
  it("skips the task and restores the attempt's own changes when the hook denies the verify", async () => {
    const trustHome = useTrustHome('consult-verify-trust-home');
    try {
      const { projectDir, sessionId } = setupRepo();
      const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
      const plan = planWith([{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }]);
      writeFileSync(
        join(projectDir, 'deny-validation.mjs'),
        "console.log(JSON.stringify({ decision: 'deny', message: 'policy: validation gated' }));\n",
      );
      const hooks: HooksConfig = {
        pre_validation: [
          {
            kind: 'command',
            command: 'node',
            args: ['deny-validation.mjs'],
            timeout_ms: 30_000,
            on_failure: 'warn',
          },
        ],
      };
      markHooksConfigTrusted(projectDir, hooks);
      const attempt = {
        ...(await getChangedFilesSnapshot(projectDir)),
        restoreFiles: ['src/greet.ts'],
      };
      writeFileSync(join(projectDir, 'src/greet.ts'), 'export const greet = "attempt";\n');
      const { ctx, events, states } = await harness({
        projectDir,
        sessionId,
        task,
        plan,
        changedFiles: ['src/greet.ts'],
      });

      const result = await applyConsultAnswer(
        { ...ctx, config: { ...ctx.config, hooks } },
        task,
        verify(['K1'], 'Verify K1'),
        attempt,
      );

      expect(result).toEqual({ action: 'skipped' });
      expect(states.at(-1)?.tasks[0]?.status).toBe('skipped');
      expect(events.filter((event) => event.type === 'checks_run')).toEqual([]);
      expect(readFileSync(join(projectDir, 'src/greet.ts'), 'utf8')).toBe(
        'export const greet = "base";\n',
      );
    } finally {
      trustHome.restore();
    }
  });
});

describe('applyConsultAnswer ask-user', () => {
  it.each(['plan', 'review'] as const)(
    'keeps the %s seat on its question and returns the answer as guidance',
    async (seat) => {
      const { projectDir, sessionId } = setupRepo();
      const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
      const plan = planWith([]);
      const replies: PlannerConversation[] = [];
      const { ctx, states } = await harness({
        projectDir,
        sessionId,
        task,
        plan,
        onPlannerReply: async (reply) => {
          replies.push(reply);
          return plainUserMessage('redis');
        },
      });
      const attempt = await getChangedFilesSnapshot(projectDir);

      const result = await applyConsultAnswer({ ...ctx, seat }, task, askUser('memory'), attempt);

      expect(result).toEqual({ action: 'guidance', instructions: 'redis', context: null });
      expect(replies).toHaveLength(1);
      expect(replies[0]?.seat).toBe(seat);
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
    },
  );

  it('takes the default when the operator answers with a bare Enter', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([]);
    const { ctx } = await harness({
      projectDir,
      sessionId,
      task,
      plan,
      onPlannerReply: async () => plainUserMessage(''),
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, askUser('memory'), attempt);

    expect(result).toEqual({ action: 'guidance', instructions: 'memory', context: null });
  });

  it('takes the default when the run is headless', async () => {
    const { projectDir, sessionId } = setupRepo();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const plan = planWith([]);
    const { ctx, states } = await harness({ projectDir, sessionId, task, plan });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(ctx, task, askUser('memory'), attempt);

    expect(result).toEqual({ action: 'guidance', instructions: 'memory', context: null });
    expect(states.at(-1)?.phase).toBe('escalating');
    expect(states.at(-1)?.userAnswers).toEqual([{ reply: 'Which store?', answer: 'memory' }]);
  });
});
