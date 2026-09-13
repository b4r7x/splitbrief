import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { RunImplementationResult } from './run-implementation.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { handleFailedImplementation } from './implementation-failure.js';

afterEach(cleanupTaskProjects);

function implState(implResult: ImplementerResult): RunImplementationResult {
  return {
    state: implementingState([makeTask()]),
    implResult,
    workspace: undefined,
    usesIsolation: false,
    preApplyApprovalDenied: false,
    preApplyApprovedFiles: [],
  };
}

describe('handleFailedImplementation — runner defects halt before the ladder', () => {
  it('unknown flag does not consume a retry', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, bus });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-recipe-invalid',
        error: 'error: unknown flag --print-timeout',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery).toMatchObject({
      reason: 'implementer-recipe-invalid',
      taskId: 'T001',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
  });

  it('a model the tool does not list halts with the same reason', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({ implementer });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'missing-model',
        error: 'model not found',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery?.reason).toBe('implementer-recipe-invalid');
  });

  it('a brief that already timed out twice halts on its own reason', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({ implementer });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-timeout-repeated',
        error: 'implementer timed out',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery?.reason).toBe('implementer-timeout-repeated');
  });
});

describe('handleFailedImplementation — scope violation retries with a revert instruction', () => {
  it('restores the undeclared write and retries with the revert instruction', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/other.ts': 'committed other\n' });
    const task = makeTask({ id: 'T001', action: 'create', file: 'src/hello.ts' });
    const state = implementingState([task]);
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = 1;\n');
    writeFileSync(join(projectDir, 'src/other.ts'), 'agent rewrote this\n');

    const retry = vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      bus,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { maxRetries: 1 },
      }),
    });

    await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-effect-invalid',
        error: "wrote outside the brief's declared files: src/other.ts",
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot,
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(readFileSync(join(projectDir, 'src/other.ts'), 'utf-8')).toBe('committed other\n');
    expect(retry).toHaveBeenCalled();
    expect(retry.mock.calls[0]?.[0]?.error).toBe(
      'Revert your changes to src/other.ts; only src/hello.ts may change',
    );
    expect(
      events.some(
        (e) =>
          e.type === 'warning' &&
          e.message ===
            'T001: implementer wrote outside the declared files (src/other.ts); retrying with a revert instruction',
      ),
    ).toBe(true);
  });
});
