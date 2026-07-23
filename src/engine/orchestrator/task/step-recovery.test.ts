import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import type { ImplementerOptions } from '../../implementers/types.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { applyRecoveryAction } from '../recovery/actions.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — recovery', () => {
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
    timeout: 90_000,
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
    timeout: 90_000,
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
});
