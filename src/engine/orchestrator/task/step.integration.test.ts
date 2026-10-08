import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { taskId } from '../../../core/schemas/task.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createContinuationHolder } from '../continuation.js';
import { enqueueUserMessage } from '../queue/submit.js';

afterEach(cleanupTaskProjects);

// Every case here drives a real git fixture repo and real snapshot/drift git
// subprocesses, so the body is a second of work in isolation and several under
// a loaded suite. The window is explicit rather than left to the default.
describe('runSingleTask — completion, abort and approval evidence', { timeout: 60_000 }, () => {
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

  // S11 T001: task_completed said 664955 ms, the ledger said 666711 ms. The clock here ticks on
  // every read, so a brief whose duration is read twice books two values.
  it('books the one measured duration on the completion event and in the ledger', async () => {
    const task = makeTask({ id: 'T001' });
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
    });
    const wctx = makeWorkflowContext({ implementer, bus });
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    try {
      await runSingleTask({
        wctx,
        task,
        index: 0,
        totalTasks: 1,
        state: implementingState([task]),
        taskBreakdowns: [],
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      });
    } finally {
      clock.mockRestore();
    }

    const complete = events.find((e) => e.type === 'task_completed');
    if (complete?.type !== 'task_completed') throw new Error('expected task_completed');
    expect(readEvidenceLedger(wctx)?.tasks[0]?.durationMs).toBe(complete.duration);
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
  it('aborting after implementation during validation returns state without entering the ladder', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/main.ts'],
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
          workflow: { review: 'task' },

          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
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
      suggestedFiles: ['src/main.ts'],
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
          workflow: { review: 'task' },

          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
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

    expect(runValidation).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
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
      suggestedFiles: ['package.json'],
      scope: { inBounds: ['package.json'] },
    });
    const state = implementingState([task]);
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'package.json'), '{"name":"hello"}\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockResolvedValue({
        decision: 'confirm',
        phrase: 'I confirm',
        reason: 'approved manifest write',
      }),
    };

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        config: makeConfig({
          workflow: { review: 'task' },

          approval: {
            feedRejectionsToPlanner: false,
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
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
        actionClass: 'package_change',
        actionDescription: 'write package.json',
        reason: 'approved manifest write',
      }),
    );
  });
});

describe('runSingleTask — checks log per validation attempt', { timeout: 60_000 }, () => {
  it('logs every attempt’s validation against the candidate it ran on', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = {
      ...implementingState([task]),
      changedFilesBaseline: { head: null, runStartChangedFiles: [], fingerprints: {} },
    };
    const write = (content: string) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/main.ts'), content);
    };
    let retries = 0;
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        write('export const main = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockImplementation(async () => {
        retries += 1;
        write(`export const main = ${retries + 1};\n`);
        return { success: true, output: 'fixed', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    let validations = 0;
    const runValidation = vi.fn().mockImplementation(async () => {
      validations += 1;
      return validations < 3
        ? [{ stage: 'test' as const, passed: false, error: `red ${validations}` }]
        : [{ stage: 'test' as const, passed: true }];
    });

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        config: makeConfig({
          workflow: { review: 'task' },
          validation: { typecheck: false, lint: false, test: true },
        }),

        projectDir,
        sessionId,
        implementer,
        planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
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

    expect(result.tasks[0]?.status).toBe('done');
    expect(runValidation).toHaveBeenCalledTimes(3);
    const logged = (readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.checks ?? []).filter(
      (entry) => entry.id === 'test',
    );
    // One record per execution, each stamped with the candidate that execution judged.
    expect(logged.map((entry) => entry.output)).toEqual(['red 1', 'red 2', undefined]);
    expect(new Set(logged.map((entry) => entry.workspaceSnapshotId)).size).toBe(3);
  });
});

describe('runSingleTask — a brief keeps its corrections on every attempt', {
  timeout: 60_000,
}, () => {
  const correction = 'keep the exported name';

  function correctedContext(
    projectDir: string,
    sessionId: string,
    implement: () => Promise<never>,
  ) {
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'still red',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: makeImplementer({ implement: vi.fn().mockImplementation(implement), retry }),
      continuation: createContinuationHolder({
        step: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
        steer: correction,
      }),
    });
    return { wctx, retry };
  }

  it('keeps a correction saved during the call when the implementer then throws', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const { wctx, retry } = correctedContext(projectDir, sessionId, async () => {
      throw new Error('socket hang up');
    });

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    for (const saved of [result, loadState({ projectDir, sessionId })]) {
      expect(saved?.lineages?.T001?.corrections).toEqual([correction]);
    }
    expect(retry).toHaveBeenCalled();
    for (const [call] of retry.mock.calls) {
      expect(call.continuation?.steer).toContain(correction);
    }
  });

  it('returns the saved correction when the call is stopped by an abort error', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const { wctx } = correctedContext(projectDir, sessionId, async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.lineages?.T001?.corrections).toEqual([correction]);
  });

  it('carries a message queued before the brief into every retry of it', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const initial = implementingState([task]);
    saveState({ projectDir, sessionId }, initial);
    const { bus } = makeBusRecorder();
    const queued = enqueueUserMessage({
      projectDir,
      sessionId,
      state: initial,
      text: 'name the helper parseAmount',
      phase: 'implementing',
      bus,
    }).state;
    const implement = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'tsc: Type X is not assignable to Y',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'still red',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        bus,
        implementer: makeImplementer({ implement, retry }),
      }),
      task,
      index: 0,
      totalTasks: 1,
      state: queued,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implement.mock.calls[0]?.[0].continuation?.steer).toContain(
      'name the helper parseAmount',
    );
    expect(retry).toHaveBeenCalled();
    for (const [call] of retry.mock.calls) {
      expect(call.continuation?.steer?.split('name the helper parseAmount')).toHaveLength(2);
    }
  });
});
