import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { getSkippedTaskIds } from '../../core/state/selectors.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makePlanner, makeImplementer, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { runTaskLoop } from './task-loop.js';
import type { WorkflowSinks } from './types.js';
import { createValidator } from './validation.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

const TEST_VALIDATOR = createValidator();

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

function makeImplState(tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  return state;
}

// Validation disabled: keeps us from spawning tsc/eslint/npm-test subprocesses.
const defaultWorkflow = { commitStrategy: 'none' as const, maxRetries: 2 };

describe('runTaskLoop', () => {
  it('task with failed dependency is skipped and emits task-skipped event', async () => {
    const { projectDir, sessionId } = setupProject();
    const t1 = makeTask({ id: 'T001', status: 'failed' });
    const t2 = makeTask({ id: 'T002', dependsOn: ['T001'] });
    let state = makeImplState([t1, t2]);
    // Simulate T001 failed: advance currentTaskIndex past it.
    state = {
      ...state,
      currentTaskIndex: 1,
      tasks: state.tasks.map((t) => (t.id === 'T001' ? { ...t, status: 'failed' } : t)),
    };

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const skipEvent = events.find((e) => e.type === 'task_skipped');
    expect(skipEvent).toBeDefined();
    expect(skipEvent).toMatchObject({ taskId: 'T002' });
    expect(getSkippedTaskIds(result.state)).toContain('T002');
  });

  it('happy path: implement → validate pass → commit when commit strategy is per-task', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    // The implementer port is a subprocess seam — we fake success via makeImplementer().
    // The implementer produces a file on disk so per-task commit has something to commit.
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'out.txt'), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
    });

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { commitStrategy: 'per-task' },
        }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
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
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus: makeBusRecorder().bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.state.tokenUsage.implementerInput).toBe(500);
    expect(result.state.tokenUsage.implementerOutput).toBe(200);
  });

  it('external changes detected on disk: onExternalChanges callback consulted, workflow cancelled on decline', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    // Write a real file to the real repo so `hasExternalChanges` returns true naturally.
    writeFileSync(join(projectDir, 'external-change.txt'), 'external edit');

    const onExternalChanges = vi.fn().mockResolvedValue(false);
    const { callbacks } = makeCallbacks({ onExternalChanges });

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus: makeBusRecorder().bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onExternalChanges).toHaveBeenCalled();
    // When external changes detected and user declines, phase transitions away from implementing.
    expect(result.state.phase).not.toBe('implementing');
  });
});
