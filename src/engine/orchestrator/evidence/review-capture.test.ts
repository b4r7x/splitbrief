import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCallbacks, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { appendReviewChanges, readReviewChanges } from '../../../core/evidence/review-changes.js';
import { hashTaskBrief } from '../../brief-hash.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { createRunIsolation } from '../isolation/create.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from '../task/step.js';
import { resolveRunReviewScope } from './review-packet/run-scope.js';

const SHARED = 'src/shared.ts';

afterEach(cleanupTaskProjects);

describe('captureTaskReviewChanges', () => {
  it('review diff is non-empty and attributed to the correct tasks', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupTaskProject();
    const first = makeTask({ id: 'T001', action: 'create', file: SHARED });
    const second = makeTask({ id: 'T002', action: 'modify', file: SHARED });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi
        .fn()
        .mockImplementation(async ({ projectDir: dir, task }: ImplementerOptions) => {
          mkdirSync(join(dir, 'src'), { recursive: true });
          const line = task.id === 'T001' ? 'export const a = 1;\n' : 'export const b = 2;\n';
          const current = task.id === 'T001' ? '' : readFileSync(join(dir, SHARED), 'utf8');
          writeFileSync(join(dir, SHARED), current + line);
          return { success: true, output: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
        }),
    });
    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    });
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });
    const workspaceDir = (await isolation.open({ config })).projectDir;
    const wctx = makeTaskWorkflowContext({
      projectDir,
      sessionId,
      workspaceDir,
      callbacks: makeCallbacks().callbacks,
      implementer,
      config,
      isolation,
    });
    const common = { wctx, taskBreakdowns: [], setTrackedState: vi.fn(), setCurrentTask: vi.fn() };

    let state = implementingState([first, second]);
    state = await runSingleTask({ ...common, task: first, index: 0, totalTasks: 2, state });
    state = await runSingleTask({ ...common, task: second, index: 1, totalTasks: 2, state });

    expect(state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    const changes = readReviewChanges({ projectDir, sessionId })?.changes ?? [];
    expect(changes.map((change) => [change.taskId, change.path, change.kind])).toEqual([
      ['T001', SHARED, 'captured'],
      ['T002', SHARED, 'captured'],
    ]);
    const scope = await resolveRunReviewScope({
      ref: { projectDir, sessionId },
      workspaceDir,
      tasks: state.tasks,
      workspaceFiles: [SHARED],
    });
    const [, byFirst = '', bySecond = ''] = scope.diff.split(/^# Changes by /m);
    expect(byFirst).toMatch(/^T001\n/);
    expect(byFirst).toContain('+export const a = 1;');
    expect(bySecond).toMatch(/^T002\n/);
    expect(bySecond).toContain('+export const b = 2;');
    expect(bySecond).not.toContain('+export const a = 1;');
    expect(scope.provenance.uncertainFiles).toEqual([]);
    await isolation.dispose();
  });

  it('records what every attempt of a retried task left, not only the last attempt', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupTaskProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/a.ts',
      files: ['src/a.ts', 'src/b.ts'],
    });
    const write = (file: string) =>
      vi.fn().mockImplementation(async ({ projectDir: dir }: ImplementerOptions) => {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, file), `export const done = '${file}';\n`);
        return { success: true, output: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
      });
    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    });
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });
    const workspaceDir = (await isolation.open({ config })).projectDir;
    const runValidation = vi
      .fn()
      .mockResolvedValueOnce([{ stage: 'test' as const, passed: false, error: 'b is missing' }])
      .mockResolvedValue([]);

    const state = await runSingleTask({
      wctx: makeTaskWorkflowContext({
        projectDir,
        sessionId,
        workspaceDir,
        implementer: makeImplementer({
          capabilities: { writesFiles: 'direct' },
          implement: write('src/a.ts'),
          retry: write('src/b.ts'),
        }),
        config,
        isolation,
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    await isolation.dispose();

    expect(state.tasks[0]?.status).toBe('done');
    const changes = readReviewChanges({ projectDir, sessionId })?.changes ?? [];
    expect(changes.map((change) => [change.taskId, change.path, change.kind])).toEqual([
      ['T001', 'src/a.ts', 'captured'],
      ['T001', 'src/b.ts', 'captured'],
    ]);
  });

  it('judges later edits against the run workspace, not the checkout', async () => {
    const { projectDir, sessionId } = setupTaskProject();
    const workspaceDir = setupTaskProject().projectDir;
    const task = makeTask({ id: 'T001', action: 'create', file: SHARED });
    const after = 'export const a = 1;\n';
    for (const dir of [projectDir, workspaceDir]) mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(workspaceDir, SHARED), after);
    writeFileSync(join(projectDir, SHARED), 'export const operator = true;\n');
    appendReviewChanges({ projectDir, sessionId }, [
      {
        taskId: task.id,
        briefHash: hashTaskBrief([task]),
        path: SHARED,
        kind: 'captured',
        before: null,
        after: {
          base64: Buffer.from(after).toString('base64'),
          sha256: sha256Hex(after),
          mode: 0o644,
        },
      },
    ]);

    const scope = await resolveRunReviewScope({
      ref: { projectDir, sessionId },
      workspaceDir,
      tasks: [task],
      workspaceFiles: [SHARED],
    });

    expect(scope.laterDiff).toBe('');
    expect(scope.provenance.uncertainFiles).toEqual([]);
    expect(scope.diff).toContain('+export const a = 1;');
  });
});
