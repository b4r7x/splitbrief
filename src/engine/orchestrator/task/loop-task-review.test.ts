import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { TASK_REVIEW_COMMANDS } from '../../events/workflow-events.js';
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
  it('default taskReview none does not emit task review gates after successful tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/review-none.ts' });
    const state = makeImplState([task]);
    const { callbacks } = makeCallbacks({
      onTaskReviewNeeded: vi.fn().mockResolvedValue({ action: 'abort' }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer: makeImplementer(),
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(result.state.currentTaskIndex).toBe(1);
    expect(events.some((event) => event.type === 'task_review_needed')).toBe(false);
  });

  it('taskReview every can continue from a successful task review into the next task', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/review-first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/review-second.ts' });
    const state = makeImplState([first, second]);
    const { callbacks } = makeCallbacks({
      onTaskReviewNeeded: async () => ({ action: 'continue' }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { ...defaultWorkflow, taskReview: 'every' } }),
        callbacks,
        implementer: makeImplementer(),
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(result.state.currentTaskIndex).toBe(2);
    expect(
      events.filter((event) => event.type === 'task_review_needed').map((event) => event.taskId),
    ).toEqual(['T001', 'T002']);
  }, 90_000);

  it('taskReview notes are queued and persisted before continuing', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', title: 'Add auth', file: 'src/review-first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/review-second.ts' });
    const state = makeImplState([first, second]);
    const reviewAnswers = [
      { action: 'continue' as const, notes: 'tighten the follow-up assertions' },
      { action: 'continue' as const },
    ];
    const { callbacks } = makeCallbacks({
      onTaskReviewNeeded: async () => reviewAnswers.shift() ?? { action: 'continue' },
    });
    const { bus, events } = makeBusRecorder();
    const setTrackedState = vi.fn();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { ...defaultWorkflow, taskReview: 'every' } }),
        callbacks,
        implementer: makeImplementer(),
        bus,
      }),
      initialState: state,
      setTrackedState,
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(result.state.currentTaskIndex).toBe(2);
    expect(result.state.messageQueue).toHaveLength(1);
    expect(result.state.messageQueue[0]).toMatchObject({
      text: expect.stringContaining('Task review note for T001 - Add auth'),
      phase: 'implementing',
      deliveredViaNative: false,
    });
    expect(result.state.messageQueue[0]?.text).toContain('tighten the follow-up assertions');
    expect(events.some((event) => event.type === 'message_queued')).toBe(true);
    expect(loadState({ projectDir, sessionId })?.messageQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('tighten the follow-up assertions'),
        }),
      ]),
    );

    const log = readFileSync(
      join(projectDir, '.splitbrief', 'sessions', sessionId, 'session.jsonl'),
      'utf-8',
    );
    expect(log).toContain('"kind":"message"');
    expect(log).toContain('Task review note for T001 - Add auth');
    expect(log).toContain('tighten the follow-up assertions');
  }, 90_000);

  it('taskReview every reports cancellation after a task review abort', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/review-first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/review-second.ts' });
    const state = makeImplState([first, second]);
    const implementer = makeImplementer();
    const { callbacks } = makeCallbacks({
      onTaskReviewNeeded: async () => ({ action: 'abort' }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { ...defaultWorkflow, taskReview: 'every' } }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('cancelled');
    expect(result.state.currentTaskIndex).toBe(1);
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'task_review_needed')).toMatchObject({
      taskId: 'T001',
      status: 'done',
      availableCommands: [...TASK_REVIEW_COMMANDS],
    });
  });

  it('taskReview failed reviews a task that recovers after an initial validation failure', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/recovered.ts' });
    const state = makeImplState([task]);
    let validationCalls = 0;
    const validator = {
      primeBaseline: vi.fn().mockResolvedValue(undefined),
      runValidation: vi.fn().mockImplementation(async () => {
        validationCalls += 1;
        return validationCalls === 1
          ? [
              {
                passed: false as const,
                stage: 'test' as const,
                error: 'expected initial validation failure',
              },
            ]
          : [{ passed: true as const, stage: 'test' as const }];
      }),
    };
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, task.file), 'initial implementation');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi
        .fn()
        .mockImplementation(async ({ projectDir: retryDir }: { projectDir: string }) => {
          mkdirSync(join(retryDir, 'src'), { recursive: true });
          writeFileSync(join(retryDir, task.file), 'recovered implementation');
          return {
            success: true,
            output: 'fixed code',
            usage: { inputTokens: 8, outputTokens: 4 },
          };
        }),
    });
    const { callbacks } = makeCallbacks({
      onTaskReviewNeeded: async () => ({ action: 'abort' }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { ...defaultWorkflow, maxRetries: 1, taskReview: 'failed' },
        }),
        callbacks,
        implementer,
        validator,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('cancelled');
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(events.find((event) => event.type === 'task_review_needed')).toMatchObject({
      taskId: 'T001',
      status: 'done',
      validation: expect.objectContaining({
        passed: false,
        summary: 'expected initial validation failure',
      }),
      filesTouched: expect.arrayContaining(['src/recovered.ts']),
    });
  });

  it('taskReview failed emits a recovery-required review gate with task metadata', async () => {
    const { projectDir, sessionId } = setupProject();

    const task = makeTask({ id: 'T003', title: 'Split large task', file: 'src/large.ts' });
    const state = makeImplState([task]);
    const implementer = makeImplementer({ implement: vi.fn() });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          implementer: { contextLength: 1 },
          workflow: { ...defaultWorkflow, taskReview: 'failed' },
        }),
        callbacks: makeCallbacks({
          onTaskReviewNeeded: async () => ({ action: 'continue' }),
        }).callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(events.find((event) => event.type === 'task_review_needed')).toMatchObject({
      type: 'task_review_needed',
      taskId: 'T003',
      taskTitle: 'Split large task',
      status: 'recovery-required',
      validation: expect.objectContaining({ passed: false }),
      recovery: expect.objectContaining({ reason: 'context-overflow' }),
      availableCommands: [...TASK_REVIEW_COMMANDS],
    });
  });

  it('taskReview failed reviews task-affecting user edit recovery stop points', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const setup = makeTask({ id: 'T003', title: 'Setup task', file: 'src/setup.ts' });
    const conflict = makeTask({ id: 'T004', title: 'Respect edits', file: 'src/conflict.ts' });
    const state = makeImplState([setup, conflict]);
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi
        .fn()
        .mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
          mkdirSync(join(runDir, 'src'), { recursive: true });
          writeFileSync(join(runDir, 'src/setup.ts'), 'export const setup = true;\n');
          writeFileSync(join(projectDir, 'src/conflict.ts'), 'user edit');
          return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
        }),
    });
    const { callbacks } = makeCallbacks({
      onUserEditConflict: vi.fn().mockResolvedValue('pause'),
      onTaskReviewNeeded: async () => ({ action: 'continue' }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { ...defaultWorkflow, taskReview: 'failed' } }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T003',
    });
    expect(events.find((event) => event.type === 'task_review_needed')).toMatchObject({
      type: 'task_review_needed',
      taskId: 'T003',
      taskTitle: 'Setup task',
      status: 'recovery-required',
      filesTouched: expect.arrayContaining(['src/conflict.ts']),
      recovery: expect.objectContaining({ reason: 'user-edit-conflict' }),
    });
  });
});
