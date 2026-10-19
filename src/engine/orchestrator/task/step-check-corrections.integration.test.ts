import { plainUserMessage } from '../../../core/types/user-input.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { loadState } from '../../../core/state/persistence.js';
import { briefCorrections } from '../../../core/state/machine.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../core/queue-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Implementer } from '../../implementers/types.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { clearPendingQueue } from '../queue/clear.js';
import { CORRECTION_AFTER_CHECKS } from './brief-gate.js';
import { runSingleTask } from './step.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTaskProjects();
});

describe('a correction during first-attempt checks', { timeout: 60_000 }, () => {
  it('completes without another BUILD call when the correction is cleared after recorded checks', async () => {
    const ref = setupTaskProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const { bus, events } = makeBusRecorder();
    bus.subscribe((event) => {
      if (event.type !== 'checks_run') return;
      const checked = loadState(ref);
      if (checked === null) throw new Error('missing recorded checks');
      clearPendingQueue({ ...ref, state: checked, bus });
    });
    const implement = vi.fn<Implementer['implement']>(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
      return { success: true, output: 'done' };
    });
    const retry = vi.fn<Implementer['retry']>(async () => ({ success: true, output: 'done' }));
    const runCommand = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      const current = loadState(ref);
      if (current === null) throw new Error('missing state during checks');
      enqueueUserMessage({
        ...ref,
        state: current,
        message: plainUserMessage('cleared correction'),
        phase: current.phase,
        bus,
      });
      return { stdout: 'ok', stderr: '', code: 0 };
    });

    const result = await runSingleTask({
      wctx: makeTaskWorkflowContext({
        ...ref,
        bus,
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        implementer: makeImplementer({ implement, retry }),
      }),
      task,
      index: 0,
      totalTasks: 1,
      state: makeImplState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implement).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(result.currentTaskIndex).toBe(1);
    expect(result.lineages?.T001).toMatchObject({ attempts: 0, consults: 0 });
    expect(result.attempt).toBe(0);
    expect(briefCorrections(result, task.id)).toEqual([]);
    expect(result.messageQueue).toEqual([]);
    expect(loadState(ref)?.messageQueue).toEqual([]);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task_retry')).toEqual([]);
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([]);
  });

  it.each([true, false])(
    'checks again after a correction with file changes: %s',
    async (changesFiles) => {
      const ref = setupTaskProject();
      const task = makeTask({
        id: 'T001',
        action: 'create',
        suggestedFiles: ['src/main.ts'],
        scope: { inBounds: ['src/main.ts'] },
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
      });
      const { bus, events } = makeBusRecorder();
      const order: string[] = [];
      const trackedStates: WorkflowState[] = [];
      bus.subscribe((event) => {
        if (event.type === 'task_completed') order.push('completed');
      });
      const implement = vi.fn<Implementer['implement']>(async ({ projectDir }) => {
        order.push('build');
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
        return { success: true, output: 'done' };
      });
      const retry = vi.fn<Implementer['retry']>(async ({ projectDir }) => {
        order.push('answer');
        if (changesFiles)
          writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 2;\n');
        return { success: true, output: 'corrected' };
      });
      let checks = 0;
      const runCommand = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
        checks += 1;
        order.push(`check ${checks}`);
        if (checks === 1) {
          const state = loadState(ref);
          if (state === null) throw new Error('missing state during checks');
          enqueueUserMessage({
            ...ref,
            state,
            message: plainUserMessage(changesFiles ? 'use two' : 'keep the public API unchanged'),
            phase: state.phase,
            bus,
          });
        }
        return { stdout: 'ok', stderr: '', code: 0 };
      });

      const result = await runSingleTask({
        wctx: makeTaskWorkflowContext({
          ...ref,
          bus,
          config: makeNoValidationConfig({ workflow: { review: 'task' } }),
          implementer: makeImplementer({ implement, retry }),
        }),
        task,
        index: 0,
        totalTasks: 1,
        state: makeImplState([task]),
        taskBreakdowns: [],
        setTrackedState: (state) => trackedStates.push(state),
        setCurrentTask: vi.fn(),
      });

      const resumed = trackedStates.find(
        (state) =>
          state.phase === 'implementing' &&
          state.tasks[0]?.status === 'in_progress' &&
          state.tasks[0]?.checkResults?.[0]?.status === 'pass',
      );
      expect(resumed).toMatchObject({ attempt: 0 });
      expect(resumed?.lineages?.T001).toMatchObject({ attempts: 0, consults: 0 });
      expect(result.pendingRecovery).toBeUndefined();
      expect(order).toEqual(['build', 'check 1', 'answer', 'check 2', 'completed']);
      expect(implement).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(retry.mock.calls[0]?.[0]).toMatchObject({
        error: CORRECTION_AFTER_CHECKS,
        attempt: 0,
        allowNoChange: true,
      });
      expect(retry.mock.calls[0]?.[0].continuation?.steer).toContain(
        changesFiles ? 'use two' : 'keep the public API unchanged',
      );
      expect(runCommand).toHaveBeenCalledTimes(2);
      expect(result.tasks[0]?.status).toBe('done');
      expect(result.currentTaskIndex).toBe(1);
      expect(result.lineages?.T001).toMatchObject({
        attempts: 2,
        attemptAllowance: 8,
        consults: 0,
      });
      expect(events.filter((event) => event.type === 'task_retry')).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'queue_drained',
          seat: 'build',
          taskId: task.id,
          count: 1,
        }),
      );
      expect(result.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
      expect(result.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
    },
  );
});
