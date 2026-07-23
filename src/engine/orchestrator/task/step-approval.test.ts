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
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — approval gates', () => {
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
    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(userEdit);
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
});
