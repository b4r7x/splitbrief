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
  it('unrelated dirty file present before the loop starts does not emit a user-edit conflict', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    writeFileSync(join(projectDir, 'external-change.txt'), 'external edit');

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalled();
    expect(result.state.currentTaskIndex).toBe(1);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('current task dirty file present before the loop starts is treated as baseline worktree state', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/current.ts' });
    const state = makeImplState([task]);

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/current.ts'), 'user edit');

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalled();
    expect(result.state.currentTaskIndex).toBe(1);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('future task dirty file present before the loop starts is checkpointed and does not block later tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const futureTask = makeTask({ id: 'T002', file: 'src/future.ts' });
    const state = makeImplState([currentTask, futureTask]);

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/future.ts'), 'user edit');

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/current.ts'), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.state.currentTaskIndex).toBe(2);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  }, 20_000);

  it('does not classify previous task output as a user edit in sequential commitStrategy none runs', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/second.ts' });
    const state = makeImplState([first, second]);
    const implementer = makeImplementer({
      implement: vi
        .fn()
        .mockImplementation(async ({ task }: { task: ReturnType<typeof makeTask> }) => {
          mkdirSync(join(projectDir, 'src'), { recursive: true });
          writeFileSync(join(projectDir, task.file), `implementation for ${task.id}`);
          return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
        }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.state.currentTaskIndex).toBe(2);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  }, 20_000);

  it('asks about a future task edit before it becomes a current-task conflict', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/current.ts' });
    const second = makeTask({ id: 'T002', action: 'modify', file: 'src/future.ts' });
    const state = makeImplState([first, second]);
    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi
        .fn()
        .mockImplementation(
          async ({
            task,
            projectDir: runDir,
          }: {
            task: ReturnType<typeof makeTask>;
            projectDir: string;
          }) => {
            mkdirSync(join(runDir, 'src'), { recursive: true });
            if (task.id === 'T001') {
              writeFileSync(join(runDir, 'src/current.ts'), 'export const current = true;\n');
              writeFileSync(join(projectDir, 'src/future.ts'), 'export const userEdit = true;\n');
            } else {
              writeFileSync(join(runDir, 'src/future.ts'), 'export const future = true;\n');
            }
            return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
          },
        ),
    });
    const onUserEditConflict = vi.fn().mockResolvedValue('continue-unrelated');
    const { callbacks } = makeCallbacks({ onUserEditConflict });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.state.currentTaskIndex).toBe(2);
    expect(onUserEditConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'future-task-stale-input',
        files: ['src/future.ts'],
        affectedTaskIds: ['T002'],
        currentTaskId: 'T001',
      }),
    );
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'continue-unrelated',
      conflict: {
        kind: 'future-task-stale-input',
        files: ['src/future.ts'],
        affectedTaskIds: ['T002'],
        currentTaskId: 'T001',
      },
    });
  }, 20_000);

  it('pauses explicitly when a future stale edit cannot continue automatically', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/current.ts' });
    const second = makeTask({ id: 'T002', action: 'modify', file: 'src/future.ts' });
    const state = makeImplState([first, second]);
    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi
        .fn()
        .mockImplementation(
          async ({
            task,
            projectDir: runDir,
          }: {
            task: ReturnType<typeof makeTask>;
            projectDir: string;
          }) => {
            mkdirSync(join(runDir, 'src'), { recursive: true });
            if (task.id === 'T001') {
              writeFileSync(join(runDir, 'src/current.ts'), 'export const current = true;\n');
              writeFileSync(join(projectDir, 'src/future.ts'), 'export const userEdit = true;\n');
            } else {
              writeFileSync(join(runDir, 'src/future.ts'), 'export const future = true;\n');
            }
            return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
          },
        ),
    });
    const onUserEditConflict = vi.fn().mockResolvedValue('pause');
    const { callbacks } = makeCallbacks({ onUserEditConflict });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.state.phase).toBe('implementing');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T001',
      affectedTaskIds: ['T001', 'T002'],
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'future-task-stale-input',
        files: ['src/future.ts'],
        affectedTaskIds: ['T002'],
      },
    });
    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
  });
});
