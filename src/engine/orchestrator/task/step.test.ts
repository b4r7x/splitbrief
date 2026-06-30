import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { loadState } from '../../../core/state/persistence.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createImplementerBase } from '../../implementers/base.js';
import { createValidator, type RunValidationOptions } from '../validation.js';
import { runSingleTask } from './step.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — happy path', () => {
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

  it('blocks actual out-of-scope changed files before validation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/unrelated.ts'), 'export const unrelated = true;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
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
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: true },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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
    expect(result.currentTaskIndex).toBe(0);
    expect(result.tasks[0]?.status).toBe('in_progress');
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();

    const rejected = events.find((e) => e.type === 'approval_rejected');
    expect(rejected).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
      reason: 'APPROVAL_REQUIRED',
    });

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.rejections?.[0]).toMatchObject({
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
      actionDescription: 'write src/unrelated.ts',
      reason: 'APPROVAL_REQUIRED',
    });
    expect(existsSync(join(projectDir, 'src/unrelated.ts'))).toBe(false);
  });

  it('runs approval before pre_task hooks and skips hooks when approval denies', async () => {
    const { projectDir, sessionId } = setupProject();
    const markerPath = join(projectDir, 'pre-task-ran.txt');
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
    });
    const state = implementingState([task]);
    const implementer = makeImplementer({ implement: vi.fn() });
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
          approval: {
            enabled: true,
            headless: true,
            feedRejectionsToPlanner: true,
            tiers: { write_in_scope: 'sticky' },
          },
          hooks: {
            pre_task: [
              {
                kind: 'command',
                command: 'node',
                args: [
                  '-e',
                  `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
                ],
                timeout_ms: 5000,
                on_failure: 'block',
              },
            ],
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(events.find((e) => e.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_in_scope',
      reason: 'APPROVAL_REQUIRED',
    });
    expect(events.find((e) => e.type === 'task_skipped')).toBeUndefined();
  });

  it('publishes workflow_cancelled and resets the task when approval returns user_cancelled', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
    });
    const state = implementingState([task]);
    const implementer = makeImplementer({ implement: vi.fn() });
    const { callbacks } = makeCallbacks({
      onTieredApproval: vi.fn().mockResolvedValue({
        decision: 'deny',
        reason: 'user_cancelled',
      }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: {
            enabled: true,
            feedRejectionsToPlanner: true,
            tiers: { write_in_scope: 'sticky' },
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(result.tasks[0]?.status).toBe('pending');
    expect(loadState({ projectDir, sessionId })?.tasks[0]?.status).toBe('pending');
    expect(events.find((event) => event.type === 'workflow_cancelled')).toMatchObject({
      type: 'workflow_cancelled',
      reason: 'user_cancelled',
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      message: 'Task blocked by approval gate: user_cancelled',
    });
  });

  it('allows actual in-scope changed files to proceed', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
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
        config: makeConfig({
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: true },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(result.currentTaskIndex).toBe(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(events.find((e) => e.type === 'approval_rejected')).toBeUndefined();
    expect(events.find((e) => e.type === 'task_completed')).toMatchObject({
      type: 'task_completed',
      taskId: 'T001',
    });

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')?.changedFiles).toContain(
      'src/hello.ts',
    );
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
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

  it('blocks out-of-scope changes to an already-dirty file (dirty-at-start detection)', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/existing.ts': 'export const v = 1;\n' });

    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
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
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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
    expect(result.currentTaskIndex).toBe(0);
    const rejected = events.find((e) => e.type === 'approval_rejected');
    expect(rejected).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
    });
  });

  it('denied out-of-scope write leaves a pre-existing user edit unchanged', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/existing.ts': 'export const v = 1;\n' });

    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(userEdit);
  });

  it('denied out-of-scope direct write in staging leaves a pre-existing user edit unchanged', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/existing.ts': 'export const v = 1;\n' });

    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(events.find((event) => event.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
    });
    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(userEdit);
  });

  it('blocks deletion of an already-dirty out-of-scope file', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/existing.ts': 'export const v = 1;\n' });

    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        unlinkSync(join(projectDir, 'src/existing.ts'));
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(events.find((event) => event.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
    });
    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(userEdit);
  });

  it('denied rollback does not erase a clean-at-start file edited during approval', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/existing.ts': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), concurrentUserEdit);
        return { decision: 'deny', reason: 'out of scope' };
      }),
    };
    const { bus, events } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(concurrentUserEdit);
    expect(events.find((event) => event.type === 'warning')).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('rollback skipped files changed during approval'),
    });
  });

  it('denied direct write leaves user edits made during approval and drops staged implementer output', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/existing.ts': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), concurrentUserEdit);
        return { decision: 'deny', reason: 'out of scope' };
      }),
    };
    const { bus } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(concurrentUserEdit);
  });

  it('approved direct write does not promote staged output over user edits made during approval', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/other.ts': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/other.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/other.ts'), concurrentUserEdit);
        return { decision: 'allow', scope: 'once' };
      }),
    };
    const runValidation = vi.fn().mockResolvedValue([]);
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(readFileSync(join(projectDir, 'src/other.ts'), 'utf-8')).toBe(concurrentUserEdit);
    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(
      events.find(
        (event) =>
          event.type === 'paused_external_changes' &&
          event.conflict?.kind === 'changed-during-approval-promotion',
      ),
    ).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['src/other.ts'],
        affectedTaskIds: ['T001'],
        safeToContinue: false,
      },
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining('promotion blocked'),
    });
  });

  it('extracted-code approval races ask for user-edit resolution instead of retrying', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/race.ts'), 'export const value = "before";\n');

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/race.ts',
      scope: { inBounds: ['src/race.ts'] },
    });
    const state = implementingState([task]);

    const implementer = createImplementerBase({
      extractsCode: true,
      invoke: vi.fn().mockResolvedValue(
        makeRunnerCallResult({
          status: 'completed',
          text: '```ts\nexport const value = "implementer";\n```',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      ),
    });
    const userEdit = 'export const value = "user";\n';
    const onUserEditConflict = vi.fn().mockResolvedValue('pause');
    let approvalCalls = 0;
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        approvalCalls++;
        if (approvalCalls === 2) {
          writeFileSync(join(projectDir, 'src/race.ts'), userEdit);
        }
        return { decision: 'allow', scope: 'once' };
      }),
      onUserEditConflict,
    };
    const runValidation = vi.fn().mockResolvedValue([]);
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: {
            enabled: true,
            feedRejectionsToPlanner: false,
            tiers: { write_in_scope: 'sticky' },
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(readFileSync(join(projectDir, 'src/race.ts'), 'utf-8')).toBe(userEdit);
    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(onUserEditConflict).not.toHaveBeenCalled();
    expect(result.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
      files: ['src/race.ts'],
      availableActions: ['skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['src/race.ts'],
      },
    });
  });

  it('raises a user-edit-conflict recovery when a foreign edit appears in the failing universe', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'src/helper.ts'] },
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
      writeFileSync(join(projectDir, 'src/helper.ts'), 'export const helper = 2; // user edit\n');
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
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(result.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T001',
    });
    expect(result.pendingRecovery?.files).toContain('src/helper.ts');
    expect(implementer.retry).not.toHaveBeenCalled();
    expect(result.tasks[0]?.status).not.toBe('done');
    expect(events.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      type: 'recovery_prompted',
      reason: 'user-edit-conflict',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
    });
  });

  it('restores failing task changes to the pre-task state when the retry ladder exhausts', {
    timeout: 30_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 999; // broken\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });
    const runValidation = vi
      .fn()
      .mockResolvedValue([{ stage: 'test' as const, passed: false, error: 'test failed' }]);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 1 },
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

    expect(result.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(readFileSync(join(projectDir, 'src/main.ts'), 'utf-8')).toBe('export const main = 0;\n');
  });

  it("does not leak a skipped task's exhausted changes into the next task's validation", {
    timeout: 30_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({
      'src/one.ts': 'export const one = 0;\n',
      'src/two.ts': 'export const two = 0;\n',
    });
    const taskOne = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/one.ts',
      scope: { inBounds: ['src/one.ts'] },
    });
    const taskTwo = makeTask({
      id: 'T002',
      action: 'modify',
      file: 'src/two.ts',
      scope: { inBounds: ['src/two.ts'] },
    });
    const state = implementingState([taskOne, taskTwo]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ task }: ImplementerOptions) => {
        // Task 1 writes broken code; task 2 writes clean code.
        if (task.id === 'T001') {
          writeFileSync(join(projectDir, 'src/one.ts'), 'export const one = 999; // broken\n');
        } else {
          writeFileSync(join(projectDir, 'src/two.ts'), 'export const two = 1;\n');
        }
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });

    // The whole-tree validator observes src/one.ts every time it runs; task 1 fails
    // forever, task 2 passes. Each call records what src/one.ts looks like on disk.
    const oneSeenByValidation: string[] = [];
    const runValidation = vi.fn().mockImplementation(async () => {
      oneSeenByValidation.push(readFileSync(join(projectDir, 'src/one.ts'), 'utf-8'));
      if (readFileSync(join(projectDir, 'src/two.ts'), 'utf-8') === 'export const two = 1;\n') {
        return [{ stage: 'test' as const, passed: true }];
      }
      return [{ stage: 'test' as const, passed: false, error: 'test failed' }];
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      callbacks,
      implementer,
      bus,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
        workflow: { commitStrategy: 'none', maxRetries: 1 },
      }),
      validator: { ...createValidator(), runValidation },
    });

    const afterTaskOne = await runSingleTask({
      wctx,
      task: taskOne,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    // Task 1 exhausts the ladder and its broken change is restored to the pre-task state.
    expect(afterTaskOne.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(readFileSync(join(projectDir, 'src/one.ts'), 'utf-8')).toBe('export const one = 0;\n');

    // Skip the exhausted task via the real recovery action, then run task 2.
    const skipResult = applyRecoveryAction({
      projectDir,
      sessionId,
      state: afterTaskOne,
      action: 'skip-current-task',
      bus,
    });
    expect(skipResult.ok).toBe(true);
    expect(skipResult.state.tasks[0]?.status).toBe('skipped');
    expect(skipResult.state.currentTaskIndex).toBe(1);

    const validationsBeforeTaskTwo = oneSeenByValidation.length;

    const afterTaskTwo = await runSingleTask({
      wctx,
      task: taskTwo,
      index: 1,
      totalTasks: 2,
      state: skipResult.state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    // Task 2 completes; its validation never saw task 1's abandoned half-fix.
    expect(afterTaskTwo.tasks[1]?.status).toBe('done');
    expect(afterTaskTwo.pendingRecovery).toBeUndefined();
    const validatedDuringTaskTwo = oneSeenByValidation.slice(validationsBeforeTaskTwo);
    expect(validatedDuringTaskTwo.length).toBeGreaterThan(0);
    for (const observed of validatedDuringTaskTwo) {
      expect(observed).toBe('export const one = 0;\n');
    }
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
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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
});
