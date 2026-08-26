import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { isolationWorktreeRoot } from '../../../core/paths.js';
import { createRunIsolation } from '../isolation/create.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { runSingleTask } from './step.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — worktree isolation', () => {
  it('gives two tasks in one run the same isolation directory, and the second task reports only its own file', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const taskA = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/a.ts',
      scope: { inBounds: ['src/a.ts'] },
    });
    const taskB = makeTask({
      id: 'T002',
      action: 'create',
      file: 'src/b.ts',
      scope: { inBounds: ['src/b.ts'] },
    });
    const state = implementingState([taskA, taskB]);

    const receivedDirs: string[] = [];
    const acceptedFiles: string[][] = [];
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        receivedDirs.push(opts.projectDir);
        const target = join(opts.projectDir, opts.task.file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `export const ${basename(opts.task.file, '.ts')} = 1;\n`);
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });

    const first = await runSingleTask({
      wctx: makeWorkflowContext({ projectDir, sessionId, callbacks, implementer, bus, isolation }),
      task: taskA,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
      onTaskAcceptedFiles: (files) => acceptedFiles.push(files),
    });

    const second = await runSingleTask({
      wctx: makeWorkflowContext({ projectDir, sessionId, callbacks, implementer, bus, isolation }),
      task: taskB,
      index: 1,
      totalTasks: 2,
      state: first,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
      onTaskAcceptedFiles: (files) => acceptedFiles.push(files),
    });

    expect(receivedDirs).toHaveLength(2);
    expect(receivedDirs[0]).toBe(receivedDirs[1]);
    expect(receivedDirs[0]).not.toBe(projectDir);
    expect(acceptedFiles).toEqual([['src/a.ts'], ['src/b.ts']]);
    expect(second.currentTaskIndex).toBe(2);
    expect(second.tasks[1]?.status).toBe('done');
    expect(readdirSync(isolationWorktreeRoot(realpathSync(join(projectDir, '.git'))))).toHaveLength(
      1,
    );

    await isolation.dispose();
  });
});
