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
import { createValidator } from '../validation.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger.js';

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

    const ledger = readEvidenceLedger(projectDir, sessionId);
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

    const ledger = readEvidenceLedger(projectDir, sessionId);
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')?.changedFiles).toContain(
      'src/hello.ts',
    );
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
      invoke: vi.fn().mockResolvedValue({
        text: '```ts\nexport const value = "implementer";\n```',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
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

    const ledger = readEvidenceLedger(projectDir, sessionId);
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
