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
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { runTaskLoop } from './loop.js';
import { readRunSnapshotLedger } from '../../snapshots/run.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-loop-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-loop';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

const defaultWorkflow = { commitStrategy: 'none' as const, maxRetries: 2 };

describe('runTaskLoop', { timeout: 30_000 }, () => {
  it('happy path completes a task after implementation and validation pass', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
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
          workflow: { commitStrategy: 'none' },
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
    expect(taskStart).toBeDefined();
    expect(taskStart).toMatchObject({ type: 'task_started', taskId: 'T001', index: 0, total: 1 });
    const taskComplete = events.find((e) => e.type === 'task_completed');
    expect(taskComplete).toBeDefined();
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

  it('auto.postTask=true causes snapshot_created event after successful task', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, task.file), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: {
          ...makeNoValidationConfig({ workflow: defaultWorkflow }),
          snapshots: { auto: { postTask: true } },
        },
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const snapshotEvent = events.find((e) => e.type === 'snapshot_created');
    expect(snapshotEvent).toBeDefined();
    expect(snapshotEvent).toMatchObject({ type: 'snapshot_created', taskIndex: 0 });

    const ledger = await readRunSnapshotLedger(projectDir, sessionId);
    expect(ledger?.accepted).toBe(false);
    expect(ledger?.rejected).toBe(false);
    if (snapshotEvent?.type === 'snapshot_created') {
      expect(ledger?.runSnapshotIds).toContain(snapshotEvent.snapshotId);
    }
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
    expect(implementer.implement).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        task: expect.objectContaining({ id: 'T001' }),
        continuationPrompt: undefined,
      }),
    );
    expect(implementer.implement).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        task: expect.objectContaining({ id: 'T002' }),
        continuationPrompt: undefined,
      }),
    );
    expect(result.state.currentTaskIndex).toBe(2);
  });
});
