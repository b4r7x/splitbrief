import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeWctx,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering } from '#testing/helpers/typed-planner.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import type { RunValidationOptions, Validator } from '../validation/types.js';
import { createValidator } from '../validation/run.js';
import { runTaskLoop } from './loop.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-consult',
    sessionId: 'sess-loop-consult',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

/** The split answer: two subtasks that together keep T002's only criterion. */
function splitIntoTwo(): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'T002 carries two jobs; split it so each half can pass alone.',
      action: 'split-task',
      tasks: [
        makeTaskSpec({
          id: 'T100',
          title: 'First half of T002',
          intent: 'Do the first half of the work T002 carried.',
          criteria: ['C2'],
          checks: [],
          suggestedFiles: ['src/b.ts'],
        }),
        makeTaskSpec({
          id: 'T101',
          title: 'Second half of T002',
          intent: 'Do the second half of the work T002 carried.',
          criteria: ['C2'],
          checks: [],
          suggestedFiles: ['src/c.ts'],
          dependsOn: ['T100'],
        }),
      ],
    },
  };
}

describe('runTaskLoop with a consult', { timeout: 90_000 }, () => {
  it('repairs a twice-failing task by splitting it, with no user prompt, and keeps earlier work', async () => {
    const { projectDir, sessionId } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], criteria: ['C2'] }),
      makeTask({
        id: 'T003',
        suggestedFiles: ['src/final.ts'],
        criteria: ['C3'],
        dependsOn: ['T002'],
      }),
    ];
    const state = makeImplState(tasks);

    // T002's first attempt and its retry leave a new file behind; the retry also
    // overwrites the file T001 completed, so the split's rollback has to put it back.
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(
          join(opts.projectDir, opts.task.suggestedFiles[0]),
          `done by ${opts.task.id}\n`,
        );
        return {
          success: true,
          output: 'wrote the brief file',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
      retry: vi.fn().mockImplementation(async (opts: RetryOptions) => {
        if (opts.kind === 'local' && opts.task.id === 'T002') {
          writeFileSync(join(opts.projectDir, 'src/a.ts'), 'broken by the T002 retry\n');
          writeFileSync(join(opts.projectDir, 'src/c.ts'), 'left by the T002 retry\n');
        }
        return {
          success: true,
          output: 'retried the brief',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    });

    // Only T002 fails validation; every other brief passes.
    const runValidation = vi.fn(async (opts: RunValidationOptions) =>
      opts.task.id === 'T002'
        ? [{ stage: 'test' as const, passed: false, error: 'T002 is not finished' }]
        : [{ stage: 'test' as const, passed: true }],
    );
    const validator: Validator = { ...createValidator(), runValidation };

    const { callbacks } = makeCallbacks({ onPlannerReply: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => splitIntoTwo()) });

    const wctx = await openRunWorkspace(
      makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks,
        planner,
        implementer,
        validator,
        bus,
      }),
    );
    const result = await runTaskLoop({
      wctx,
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    // No planner reply or question reached the operator, and the run did not halt.
    expect(callbacks.onPlannerReply).not.toHaveBeenCalled();
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');

    // The parent is gone from the task list; its record keeps it in the lineage.
    const byId = new Map(result.state.tasks.map((task) => [task.id, task]));
    expect(byId.has(taskId('T002'))).toBe(false);
    expect(result.state.lineages?.T002?.replacedParents.map((task) => task.id)).toEqual(['T002']);

    // The split's children replaced the parent in answer order and share its lineage.
    expect(byId.get(taskId('T004'))).toMatchObject({ status: 'done', parentId: 'T002' });
    expect(byId.get(taskId('T005'))).toMatchObject({ status: 'done', parentId: 'T002' });
    expect(byId.get(taskId('T003'))?.dependsOn).toEqual(['T004', 'T005']);
    expect(byId.get(taskId('T003'))?.status).toBe('done');

    // Two implementer attempts on T002, one consult on its lineage.
    expect(result.state.lineages?.T002).toMatchObject({ attempts: 2, consults: 1 });

    // T001's work survived the failed retry and the split's rollback, in the run
    // workspace; the checkout never received any of it.
    expect(readFileSync(join(wctx.workspaceDir, 'src/a.ts'), 'utf-8')).toBe('done by T001\n');
    expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'consult_answered',
        taskId: 'T002',
        reason: 'failed',
        action: 'split-task',
        newTaskIds: ['T004', 'T005'],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tasks_inserted',
        parentId: 'T002',
        taskIds: ['T004', 'T005'],
      }),
    );
  });
});
