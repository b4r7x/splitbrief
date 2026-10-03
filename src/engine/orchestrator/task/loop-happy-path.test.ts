import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { loadState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { runTaskLoop } from './loop.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-test',
    sessionId: 'sess-loop',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

const defaultWorkflow = { maxRetries: 2 };

describe('runTaskLoop', { timeout: 90_000 }, () => {
  it('happy path completes a task after implementation and validation pass', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts) => {
        opts.onOutput?.('streamed chunk');
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, task.file), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
    });

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: {},
        }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const taskStart = events.find((e) => e.type === 'task_started');
    expect(taskStart).toMatchObject({
      type: 'task_started',
      taskId: 'T001',
      index: 0,
      total: 1,
      files: ['src/hello.ts'],
    });
    const taskComplete = events.find((e) => e.type === 'task_completed');
    expect(taskComplete).toMatchObject({ type: 'task_completed', taskId: 'T001', method: 'local' });
  });

  it('token usage accumulated on state through implementer', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 500, outputTokens: 200 },
      }),
    });

    const { callbacks } = makeCallbacks();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.state.tokenUsage.implementerInput).toBe(500);
    expect(result.state.tokenUsage.implementerOutput).toBe(200);
  });

  it('persists per-task breakdowns and re-seeds them on re-entry (F-454)', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/second.ts' });
    const state = makeImplState([first, second]);
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 300, outputTokens: 120 },
      }),
    });
    const { callbacks } = makeCallbacks();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.taskBreakdowns.map((b) => b.taskId)).toEqual(['T001', 'T002']);
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.taskBreakdowns?.map((b) => b.taskId)).toEqual(['T001', 'T002']);

    // Re-entry: a fresh loop seeded from the persisted state keeps prior attribution
    // rather than erasing it and re-pricing under the primary identity.
    const reentry = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer: makeImplementer({ implement: vi.fn() }),
        bus: makeBusRecorder().bus,
      }),
      initialState: persisted ?? state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(reentry.taskBreakdowns.map((b) => b.taskId)).toEqual(['T001', 'T002']);
  });

  it('dispatches each task as a separate implementer call without prior task continuation text', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/second.ts' });
    const state = makeImplState([first, second]);
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const { callbacks } = makeCallbacks();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    // Each brief is its own call, and neither carries anything the brief before it left behind.
    const dispatched = vi.mocked(implementer.implement).mock.calls;
    expect(dispatched[0]?.[0]?.task.id).toBe('T001');
    expect(dispatched[0]?.[0]?.continuation).toBeUndefined();
    expect(dispatched[1]?.[0]?.task.id).toBe('T002');
    expect(dispatched[1]?.[0]?.continuation).toBeUndefined();
    expect(result.state.currentTaskIndex).toBe(2);
  });

  it('points the task index at the brief it runs after skipping a passed one', async () => {
    const { projectDir, sessionId } = setupProject();
    const reopened = makeTask({ id: 'T001', file: 'src/first.ts' });
    const passed = makeTask({ id: 'T002', file: 'src/second.ts', status: 'done' });
    const next = makeTask({ id: 'T003', file: 'src/third.ts' });
    const state = makeImplState([reopened, passed, next]);
    const ref = { projectDir, sessionId };
    const seen: { index: number | undefined; cut: unknown }[] = [];
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        const persisted = loadState(ref);
        if (persisted !== null) {
          const step = resumeStep(persisted);
          const stopped = transition(persisted, {
            type: 'INTERRUPT_STEP',
            step,
            source: 'user',
            cut: 'mid-step',
          });
          seen.push({ index: persisted.currentTaskIndex, cut: stopped.interruptedStep?.step });
        }
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(seen).toEqual([
      { index: 0, cut: { kind: 'brief', taskId: 'T001', attempt: 0 } },
      { index: 2, cut: { kind: 'brief', taskId: 'T003', attempt: 0 } },
    ]);
    expect(result.status).toBe('complete');
    expect(result.state.tasks.map((t) => t.status)).toEqual(['done', 'done', 'done']);
  });
});
