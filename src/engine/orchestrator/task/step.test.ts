import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { TREES_DIR } from '../../../core/paths.js';
import { createRunIsolation } from '../isolation/create.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createValidator } from '../validation/run.js';
import type { RunValidationOptions } from '../validation/types.js';
import { decideValidationAcceptance } from '../validation/acceptance.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-single-task-trust-home');
});

afterEach(() => {
  cleanupTaskProjects();
  trustHome.restore();
});

describe('runSingleTask — completion and abort', () => {
  it('emits task-start and task-complete, advances to done, and records token usage', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'ok',
        usage: { inputTokens: 300, outputTokens: 120 },
      }),
    });

    const wctx = makeWorkflowContext({ callbacks, implementer, bus });

    const taskBreakdowns: TaskTokenUsage[] = [];
    const setTrackedState = vi.fn();
    const setCurrentTask = vi.fn();

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns,
      setTrackedState,
      setCurrentTask,
    });

    expect(result.currentTaskIndex).toBe(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(result.pendingRecovery).toBeUndefined();

    expect(result.tokenUsage.implementerInput).toBe(300);
    expect(result.tokenUsage.implementerOutput).toBe(120);

    const start = events.find((e) => e.type === 'task_started');
    const complete = events.find((e) => e.type === 'task_completed');
    expect(start).toMatchObject({ type: 'task_started', taskId: 'T001', index: 0, total: 1 });
    expect(complete).toMatchObject({ type: 'task_completed', taskId: 'T001', method: 'local' });

    expect(taskBreakdowns).toHaveLength(1);
    expect(taskBreakdowns[0]).toMatchObject({ taskId: 'T001', method: 'local' });
  });

  it('returns state unchanged when the signal is already aborted on entry', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const controller = new AbortController();
    controller.abort();

    const implement = vi.fn();
    const implementer = makeImplementer({ implement });
    const wctx = makeWorkflowContext({ implementer, signal: controller.signal });

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implement).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(state.currentTaskIndex);
    expect(result.tasks[0]?.status).toBe('pending');
  });
  it('skips the task (not silently stops) when a pre_validation hook denies', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    writeFileSync(
      join(projectDir, 'deny-validation.mjs'),
      [
        'export default function () {',
        "  return { kind: 'deny', message: 'policy: validation gated' };",
        '}',
      ].join('\n'),
    );

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const hooks: HooksConfig = {
      pre_validation: [
        {
          kind: 'module',
          path: 'deny-validation.mjs',
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          hooks,
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(runValidation).not.toHaveBeenCalled();
    expect(result.tasks[0]?.status).toBe('skipped');
    expect(result.currentTaskIndex).toBe(1);
    expect(result.pendingRecovery).toBeUndefined();
    expect(events.find((e) => e.type === 'task_skipped')).toMatchObject({
      type: 'task_skipped',
      taskId: 'T001',
      reason: 'policy: validation gated',
    });
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(existsSync(join(projectDir, 'src/hello.ts'))).toBe(false);
    expect(
      events.find(
        (e) =>
          e.type === 'warning' &&
          e.message.includes('unvalidated task change(s) after pre_validation denied'),
      ),
    ).toBeDefined();

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')).toMatchObject({
      id: 'T001',
      status: 'skipped',
    });
  });
  it('aborting after implementation during validation returns state without entering the ladder', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(),
    });
    const runValidation = vi.fn().mockImplementation(async () => {
      controller.abort();
      return [{ stage: 'test' as const, passed: false, error: 'test failed' }];
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        signal: controller.signal,
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(result.pendingRecovery).toBeUndefined();
    expect(result.tasks[0]?.status).not.toBe('done');
    expect(events.find((e) => e.type === 'recovery_prompted')).toBeUndefined();
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
  });

  it('aborting after validation passes returns state without completing the task', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(),
    });
    const runValidation = vi.fn().mockImplementation(async (opts: RunValidationOptions) => {
      expect(opts.signal).toBe(controller.signal);
      controller.abort();
      return [{ stage: 'test' as const, passed: true }];
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        signal: controller.signal,
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(result.pendingRecovery).toBeUndefined();
    expect(result.tasks[0]?.status).not.toBe('done');
    expect(result.currentTaskIndex).toBe(0);
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
  });

  it('rejects a task that introduces a new failure in a stage already red at baseline', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([
      {
        stage: 'typecheck' as const,
        passed: false,
        error: 'TS error',
        failureFiles: ['src/main.ts'],
      },
    ]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          validation: { typecheck: true, lint: false, test: false, typecheckCommand: 'noop' },
          workflow: { maxRetries: 1 },
        }),
        validator: {
          ...createValidator(),
          runValidation,
          decideAcceptance: ({ results, changedFiles }) =>
            decideValidationAcceptance({
              results,
              changedFiles,
              baselineFailingStages: new Set<ValidationStage>(['typecheck']),
            }),
        },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.tasks[0]?.status).not.toBe('done');
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(implementer.retry).toHaveBeenCalled();
    expect(
      events.find((e) => e.type === 'warning' && e.code === 'validation_baseline_exempt'),
    ).toBeUndefined();
  });

  it('records the exempt stages in the ledger when a task completes over a pre-existing failure', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(),
    });
    const runValidation = vi.fn().mockResolvedValue([
      {
        stage: 'typecheck' as const,
        passed: false,
        error: 'TS error',
        failureFiles: ['src/unrelated.ts'],
      },
    ]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          validation: { typecheck: true, lint: false, test: false, typecheckCommand: 'noop' },
          workflow: { maxRetries: 1 },
        }),
        validator: {
          ...createValidator(),
          runValidation,
          decideAcceptance: ({ results, changedFiles }) =>
            decideValidationAcceptance({
              results,
              changedFiles,
              baselineFailingStages: new Set<ValidationStage>(['typecheck']),
            }),
        },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.tasks[0]?.status).toBe('done');
    expect(implementer.retry).not.toHaveBeenCalled();
    expect(
      events.find((e) => e.type === 'warning' && e.code === 'validation_baseline_exempt'),
    ).toMatchObject({ code: 'validation_baseline_exempt' });
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')?.validation).toMatchObject([
      { stage: 'typecheck', passed: false, baselineExempt: true },
    ]);
    expect(ledger?.tasks[0]?.observedEvidence).toContain('typecheck failed (pre-existing)');
  });

  it('persists successful confirm reasons in the evidence ledger', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockResolvedValue({
        decision: 'confirm',
        phrase: 'I confirm',
        reason: 'approved scoped source write',
      }),
    };

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        config: makeConfig({
          approval: {
            enabled: true,
            feedRejectionsToPlanner: false,
            tiers: { write_in_scope: 'confirm' },
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
        }),
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.approvals).toContainEqual(
      expect.objectContaining({
        taskId: 'T001',
        tier: 'confirm',
        actionClass: 'write_in_scope',
        actionDescription: 'create src/hello.ts',
        reason: 'approved scoped source write',
      }),
    );
  });

  it('gives two tasks in one run the same isolation directory, and the second task reports only its own file', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const taskA = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/a.ts',
      scope: { inBounds: ['src/a.ts'] },
    });
    const taskB = makeTask({
      id: 'T002',
      action: 'create',
      file: 'src/b.ts',
      scope: { inBounds: ['src/b.ts'] },
    });
    const state = implementingState([taskA, taskB]);

    const receivedDirs: string[] = [];
    const acceptedFiles: string[][] = [];
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        receivedDirs.push(opts.projectDir);
        const target = join(opts.projectDir, opts.task.file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `export const ${basename(opts.task.file, '.ts')} = 1;\n`);
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });

    const first = await runSingleTask({
      wctx: makeWorkflowContext({ projectDir, sessionId, callbacks, implementer, bus, isolation }),
      task: taskA,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
      onTaskAcceptedFiles: (files) => acceptedFiles.push(files),
    });

    const second = await runSingleTask({
      wctx: makeWorkflowContext({ projectDir, sessionId, callbacks, implementer, bus, isolation }),
      task: taskB,
      index: 1,
      totalTasks: 2,
      state: first,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
      onTaskAcceptedFiles: (files) => acceptedFiles.push(files),
    });

    expect(receivedDirs).toHaveLength(2);
    expect(receivedDirs[0]).toBe(receivedDirs[1]);
    expect(receivedDirs[0]).not.toBe(projectDir);
    expect(acceptedFiles).toEqual([['src/a.ts'], ['src/b.ts']]);
    expect(second.currentTaskIndex).toBe(2);
    expect(second.tasks[1]?.status).toBe('done');
    expect(readdirSync(join(projectDir, TREES_DIR))).toHaveLength(1);

    await isolation.dispose();
  });
});
