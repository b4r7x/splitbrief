import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makePlanner,
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
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import { isolationWorktreeRoot, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { createRunIsolation } from '../isolation/create.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { RunValidationOptions } from '../validation/types.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';

afterEach(cleanupTaskProjects);

/** Every checkout file outside git and SPLITBRIEF's own state, with its bytes. */
function checkoutFiles(projectDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(projectDir, path);
      if (rel === '.git' || rel === SPLITBRIEF_DIR) continue;
      if (entry.isDirectory()) walk(path);
      else files[rel] = readFileSync(path).toString('base64');
    }
  };
  walk(projectDir);
  return files;
}

describe('runSingleTask — worktree isolation', () => {
  it('keeps the checkout byte-identical across a failing task and a passing task', {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const failing = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
    });
    const passing = makeTask({
      id: 'T002',
      action: 'create',
      suggestedFiles: ['src/b.ts'],
      scope: { inBounds: ['src/b.ts'] },
    });
    const state = implementingState([failing, passing]);
    const before = checkoutFiles(projectDir);

    const receivedDirs: string[] = [];
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        receivedDirs.push(opts.projectDir);
        const target = join(opts.projectDir, opts.task.suggestedFiles[0]);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          `export const ${basename(opts.task.suggestedFiles[0], '.ts')} = 999;\n`,
        );
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });
    const runValidation = vi.fn(async (opts: RunValidationOptions) =>
      opts.task.id === 'T001'
        ? [{ stage: 'test' as const, passed: false, error: 'T001 is broken' }]
        : [{ stage: 'test' as const, passed: true }],
    );
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus: makeBusRecorder().bus,
        isolation,
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
        }),
        planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
        validator: { ...createValidator(), runValidation },
      }),
    );

    const afterFailing = await runSingleTask({
      wctx,
      task: failing,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(afterFailing.pendingRecovery?.reason).toBe('consult-bound-spent');
    expect(checkoutFiles(projectDir)).toEqual(before);

    const afterPassing = await runSingleTask({
      wctx,
      task: passing,
      index: 1,
      totalTasks: 2,
      state: { ...afterFailing, pendingRecovery: undefined, currentTaskIndex: 1 },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(afterPassing.tasks[1]?.status).toBe('done');
    expect(checkoutFiles(projectDir)).toEqual(before);

    expect(receivedDirs).toEqual([wctx.workspaceDir, wctx.workspaceDir]);
    expect(wctx.workspaceDir).not.toBe(projectDir);
    expect(readFileSync(join(wctx.workspaceDir, 'src/main.ts'), 'utf-8')).toBe(
      'export const main = 0;\n',
    );
    expect(readFileSync(join(wctx.workspaceDir, 'src/b.ts'), 'utf-8')).toBe(
      'export const b = 999;\n',
    );
    expect(readdirSync(isolationWorktreeRoot(realpathSync(join(projectDir, '.git'))))).toHaveLength(
      1,
    );

    await isolation.dispose();
  });

  it("keeps a stopped attempt's partial in the run workspace when its call throws on the stop", {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/partial.ts'],
      scope: { inBounds: ['src/partial.ts'] },
    });
    const controller = new AbortController();
    const invoke = vi.fn().mockImplementation(async (opts: { projectDir: string }) => {
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, 'src/partial.ts'), 'export const partial = 1;\n');
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const retained: string[] = [];
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: (dir) => retained.push(dir),
    });
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks: makeCallbacks().callbacks,
        implementer: createImplementerBase(makeBaseConfig({ extractsCode: false, invoke })),
        bus: makeBusRecorder().bus,
        isolation,
        signal: controller.signal,
      }),
    );
    const before = checkoutFiles(projectDir);

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
    await isolation.dispose();

    expect(readFileSync(join(wctx.workspaceDir, 'src/partial.ts'), 'utf-8')).toBe(
      'export const partial = 1;\n',
    );
    expect(retained).toEqual([wctx.workspaceDir]);
    expect(checkoutFiles(projectDir)).toEqual(before);
  });
});
