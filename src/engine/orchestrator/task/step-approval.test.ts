import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
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
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createSnapshot } from '../../snapshots/create.js';
import { reconcileWorkspaceToBase } from '../isolation/acquisition.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — approval gates', () => {
  it('completes a brief that also edits an unplanned ordinary file and records it', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: ImplementerOptions) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = 1;\n');
        writeFileSync(join(projectDir, 'src/unrelated.ts'), 'export const unrelated = true;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: true },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        }),
        validator: { ...createValidator(), runValidation },
      }),
    );
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

    expect(result.currentTaskIndex).toBe(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(implementer.retry).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'approval_prompted')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/revert/i);
    expect(runValidation).toHaveBeenCalledWith(
      expect.objectContaining({ changedFiles: expect.arrayContaining(['src/unrelated.ts']) }),
    );
    expect(events.find((e) => e.type === 'task_touched_not_suggested')).toMatchObject({
      taskId: 'T001',
      files: ['src/unrelated.ts'],
    });
    expect(readFileSync(join(wctx.workspaceDir, 'src/unrelated.ts'), 'utf-8')).toContain(
      'unrelated',
    );
  });

  it('asks once for a protected write with approval off; a denial discards only that file', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', action: 'create', file: 'src/hello.ts' });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: ImplementerOptions) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = 1;\n');
        writeFileSync(join(projectDir, '.env.local'), 'TOKEN=1\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const onTieredApproval = vi.fn().mockResolvedValue({ decision: 'deny', reason: 'no' });
    const { callbacks } = makeCallbacks({ onTieredApproval });
    const { bus, events } = makeBusRecorder();

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: false, feedRejectionsToPlanner: true },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        }),
      }),
    );
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

    expect(onTieredApproval).toHaveBeenCalledTimes(1);
    expect(onTieredApproval).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'confirm', actionDescription: 'write .env.local' }),
    );
    expect(existsSync(join(wctx.workspaceDir, '.env.local'))).toBe(false);
    expect(readFileSync(join(wctx.workspaceDir, 'src/hello.ts'), 'utf-8')).toBe(
      'export const hello = 1;\n',
    );
    expect(result.tasks[0]?.status).toBe('done');
    expect(implementer.retry).not.toHaveBeenCalled();
    const error = events.find((e) => e.type === 'error');
    expect(error?.message).toBe(
      "Approval gate denied .env.local: no. SPLITBRIEF discarded this attempt's writes to .env.local.",
    );
    expect(error?.message).not.toMatch(/revert/i);
  });

  it('asks once for a protected file the brief declares, at the write', async () => {
    const { projectDir, sessionId } = setupProject({ 'package.json': '{}\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/a.ts',
      files: ['src/a.ts', 'package.json'],
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: ImplementerOptions) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 1;\n');
        writeFileSync(join(projectDir, 'package.json'), '{ "name": "a" }\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const onTieredApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'needed' });
    const { callbacks } = makeCallbacks({ onTieredApproval });

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: true },
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

    expect(onTieredApproval).toHaveBeenCalledTimes(1);
    expect(onTieredApproval).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'confirm', actionDescription: 'write package.json' }),
    );
    expect(result.tasks[0]?.status).toBe('done');
  });

  it('discards the workspace protected write and preserves the checkout edit made during the prompt', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', action: 'create', file: 'src/hello.ts' });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: ImplementerOptions) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = 1;\n');
        writeFileSync(join(projectDir, '.env.local'), 'TOKEN=1\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const onTieredApproval = vi.fn().mockImplementation(async () => {
      writeFileSync(join(projectDir, '.env.local'), 'TOKEN=2 # user edit\n');
      return { decision: 'deny', reason: 'no' };
    });
    const { callbacks } = makeCallbacks({ onTieredApproval });
    const { bus, events } = makeBusRecorder();

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: true },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        }),
      }),
    );
    await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toBe('TOKEN=2 # user edit\n');
    const error = events.find((e) => e.type === 'error');
    expect(error?.message).toContain("SPLITBRIEF discarded this attempt's writes to .env.local.");
    expect(readFileSync(join(wctx.workspaceDir, 'src/hello.ts'), 'utf8')).toBe(
      'export const hello = 1;\n',
    );
  });

  it('allows actual in-scope changed files to proceed', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: ImplementerOptions) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
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
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: true },
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

    expect(result.currentTaskIndex).toBe(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(events.find((e) => e.type === 'approval_rejected')).toBeUndefined();
    expect(events.find((e) => e.type === 'task_completed')).toMatchObject({
      type: 'task_completed',
      taskId: 'T001',
    });

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')?.changedFiles).toContain(
      'src/hello.ts',
    );
  });

  async function runDirtyProtectedTask(opts: {
    mutate: (projectDir: string) => void;
    runValidation?: ReturnType<typeof createValidator>['runValidation'];
  }) {
    const { projectDir, sessionId } = setupProject({ '.env.local': 'TOKEN=1\n' });

    const userEdit = 'TOKEN=2 # user edit\n';
    writeFileSync(join(projectDir, '.env.local'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: ImplementerOptions) => {
        opts.mutate(projectDir);
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      callbacks,
      implementer,
      bus,
      config: makeConfig({
        approval: { enabled: true, feedRejectionsToPlanner: false },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      }),
      ...(opts.runValidation === undefined
        ? {}
        : { validator: { ...createValidator(), runValidation: opts.runValidation } }),
    });
    const base = await createSnapshot({
      projectDir,
      sessionId,
      phase: 'manual',
      name: 'workspace-base',
    });
    const workspace = await wctx.isolation.open({ config: wctx.config });
    await reconcileWorkspaceToBase({
      projectDir,
      sessionId,
      snapshotId: base.manifest.id,
      workspaceDir: workspace.projectDir,
      keep: workspace.keptFiles,
    });
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

    return { projectDir, sessionId, userEdit, events, result };
  }

  it('blocks protected changes to an already-dirty file (dirty-at-start detection)', async () => {
    const runValidation = vi.fn().mockResolvedValue([]);
    const { projectDir, userEdit, events, result } = await runDirtyProtectedTask({
      mutate: (dir) => writeFileSync(join(dir, '.env.local'), 'TOKEN=99\n'),
      runValidation,
    });

    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(result.pendingRecovery).toMatchObject({
      reason: 'approval-denied',
      files: ['.env.local'],
    });
    expect(events.find((e) => e.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'sensitive_change',
    });
    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toBe(userEdit);
  });

  it('records the denied protected write in the evidence ledger', async () => {
    const { projectDir, sessionId } = await runDirtyProtectedTask({
      mutate: (dir) => writeFileSync(join(dir, '.env.local'), 'TOKEN=99\n'),
    });

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.rejections).toContainEqual(
      expect.objectContaining({ actionClass: 'sensitive_change' }),
    );
  });

  it('records one rejection per denied protected write', async () => {
    const { projectDir, sessionId } = await runDirtyProtectedTask({
      mutate: (dir) => {
        writeFileSync(join(dir, '.env.local'), 'TOKEN=99\n');
        writeFileSync(join(dir, 'package.json'), '{"name":"changed"}\n');
      },
    });

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.rejections?.map((r) => r.actionDescription).sort()).toEqual([
      'write .env.local',
      'write package.json',
    ]);
  });

  it('blocks deletion of an already-dirty protected file', async () => {
    const { projectDir, userEdit, events } = await runDirtyProtectedTask({
      mutate: (dir) => unlinkSync(join(dir, '.env.local')),
    });

    expect(events.find((event) => event.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'sensitive_change',
    });
    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toBe(userEdit);
  });
});
