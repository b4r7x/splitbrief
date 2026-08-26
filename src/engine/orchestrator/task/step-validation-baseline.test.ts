import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { createValidator } from '../validation/run.js';
import { decideValidationAcceptance } from '../validation/acceptance.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — baseline-exempt validation', () => {
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
});
