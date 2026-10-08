import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — a red also red at the run base', () => {
  it('rejects a task whose red at the run base names a file the task changed', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: { projectDir: string }) => {
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
        stage: 'test' as const,
        passed: false,
        error: 'TS error',
        failureFiles: ['src/main.ts'],
        failingTests: [{ file: 'src/main.ts', name: 'main', message: 'TS error' }],
        preExisting: ['src/main.ts::main'],
      },
    ]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: await openRunWorkspace(
        makeWorkflowContext({
          projectDir,
          sessionId,
          callbacks,
          implementer,
          bus,
          config: makeConfig({
            workflow: { review: 'task' },

            validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          }),
          validator: {
            ...createValidator(),
            runValidation,
          },
        }),
      ),
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
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi
        .fn()
        .mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
          mkdirSync(join(runDir, 'src'), { recursive: true });
          writeFileSync(join(runDir, 'src/main.ts'), 'export const main = 1;\n');
          return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
        }),
      retry: vi.fn(),
    });
    const runValidation = vi.fn().mockResolvedValue([
      {
        stage: 'test' as const,
        passed: false,
        error: 'TS error',
        failureFiles: ['src/unrelated.ts'],
        failingTests: [{ file: 'src/unrelated.ts', name: 'unrelated', message: 'TS error' }],
        preExisting: ['src/unrelated.ts::unrelated'],
      },
    ]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: await openRunWorkspace(
        makeWorkflowContext({
          projectDir,
          sessionId,
          callbacks,
          implementer,
          bus,
          config: makeConfig({
            workflow: { review: 'task' },

            validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          }),
          validator: {
            ...createValidator(),
            runValidation,
          },
        }),
      ),
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
      { stage: 'test', passed: false, baselineExempt: true },
    ]);
  });
});
