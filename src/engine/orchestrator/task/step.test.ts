import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext, WorkflowSinks } from '../types.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createImplementerBase } from '../../implementers/base.js';
import { createValidator } from '../validation.js';
import { runSingleTask } from './step.js';
import { retryAndRecord } from './retry.js';
import { readEvidenceLedger } from '../evidence/evidence.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-step-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-task-step';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeSinks(): WorkflowSinks {
  return { setAbortHandler: () => {}, setQueueHandler: () => {} };
}

function implementingState(tasks: Task[]): WorkflowState {
  let s = createInitialState('feat');
  s = transition(s, { type: 'START', feature: 'feat' });
  s = transition(s, { type: 'RESEARCH_DONE' });
  s = transition(s, { type: 'SPEC_DONE' });
  s = transition(s, { type: 'APPROVE_SPEC' });
  s = transition(s, { type: 'PLAN_DONE', tasks });
  s = transition(s, { type: 'APPROVE_PLAN' });
  return {
    ...s,
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  };
}

function makeWorkflowContext(overrides?: Partial<WorkflowContext>): WorkflowContext {
  const proj = overrides?.projectDir
    ? { projectDir: overrides.projectDir, sessionId: overrides.sessionId ?? 'sess-task-step' }
    : setupProject();
  const callbacks = overrides?.callbacks ?? makeCallbacks().callbacks;
  const base: WorkflowContext = {
    projectDir: proj.projectDir,
    sessionId: proj.sessionId,
    config: makeConfig({
      // Disable validation subprocess entirely — keeps the test focused on task-step
      // plumbing, not on tsc/eslint/npm test I/O.
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { commitStrategy: 'none', maxRetries: 2 },
    }),
    callbacks,
    bus: makeBusRecorder().bus,
    planner: makePlanner(),
    implementer: makeImplementer(),
    context: defaultContext,
    metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
    sinks: makeSinks(),
    validator: createValidator(),
  };
  return { ...base, ...overrides, projectDir: proj.projectDir, sessionId: proj.sessionId, callbacks };
}

describe('runSingleTask — happy path', () => {
  it('emits task-start and task-complete, advances to done, and records token usage', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'ok',
        usage: { inputTokens: 300, outputTokens: 120 },
      }),
    });

    const wctx = makeWorkflowContext({ callbacks, implementer, bus });

    const taskBreakdowns: TaskTokenUsage[] = [];
    const setTrackedState = vi.fn();
    const setCurrentTask = vi.fn();

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns,
      setTrackedState,
      setCurrentTask,
    });

    // Completed task → advanced past it.
    expect(result.currentTaskIndex).toBe(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(result.pendingRecovery).toBeUndefined();

    // Token usage accumulated on state.
    expect(result.tokenUsage.implementerInput).toBe(300);
    expect(result.tokenUsage.implementerOutput).toBe(120);

    const start = events.find((e) => e.type === 'task_started');
    const complete = events.find((e) => e.type === 'task_completed');
    expect(start).toMatchObject({ type: 'task_started', taskId: 'T001', index: 0, total: 1 });
    expect(complete).toMatchObject({ type: 'task_completed', taskId: 'T001', method: 'local' });

    // One per-task breakdown recorded.
    expect(taskBreakdowns).toHaveLength(1);
    expect(taskBreakdowns[0]).toMatchObject({ taskId: 'T001', method: 'local' });
  });

  it('returns state unchanged when the signal is already aborted on entry', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const controller = new AbortController();
    controller.abort();

    const implement = vi.fn();
    const implementer = makeImplementer({ implement });
    const wctx = makeWorkflowContext({ implementer, signal: controller.signal });

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

    expect(implement).not.toHaveBeenCalled();
    // Task was not advanced.
    expect(result.currentTaskIndex).toBe(state.currentTaskIndex);
    expect(result.tasks[0]?.status).toBe('pending');
  });

  it('blocks actual out-of-scope changed files before validation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/unrelated.ts'), 'export const unrelated = true;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
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
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: true },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(result.tasks[0]?.status).toBe('in_progress');
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();

    const rejected = events.find((e) => e.type === 'approval_rejected');
    expect(rejected).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
      reason: 'APPROVAL_REQUIRED',
    });

    const ledger = readEvidenceLedger(projectDir, sessionId);
    expect(ledger?.rejections?.[0]).toMatchObject({
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
      actionDescription: 'write src/unrelated.ts',
      reason: 'APPROVAL_REQUIRED',
    });
    expect(existsSync(join(projectDir, 'src/unrelated.ts'))).toBe(false);
  });

  it('runs approval before pre_task hooks and skips hooks when approval denies', async () => {
    const { projectDir, sessionId } = setupProject();
    const markerPath = join(projectDir, 'pre-task-ran.txt');
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
    });
    const state = implementingState([task]);
    const implementer = makeImplementer({ implement: vi.fn() });
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
          approval: {
            enabled: true,
            headless: true,
            feedRejectionsToPlanner: true,
            tiers: { write_in_scope: 'sticky' },
          },
          hooks: {
            pre_task: [{
              kind: 'command',
              command: 'node',
              args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
              timeout_ms: 5000,
              on_failure: 'block',
            }],
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(events.find((e) => e.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_in_scope',
      reason: 'APPROVAL_REQUIRED',
    });
    expect(events.find((e) => e.type === 'task_skipped')).toBeUndefined();
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
      implement: vi.fn().mockImplementation(async () => {
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
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: true },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    const ledger = readEvidenceLedger(projectDir, sessionId);
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')?.changedFiles).toContain('src/hello.ts');
  });

  it('blocks out-of-scope changes to an already-dirty file (dirty-at-start detection)', async () => {
    const { projectDir, sessionId } = setupProject();

    // Commit a file, then make it dirty (user edit) before the task starts
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 1;\n');
    execSync('git add . && git commit -m "add existing"', { cwd: projectDir, stdio: 'pipe' });
    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        // Implementer writes to an out-of-scope file that was already dirty
        writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
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
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    const rejected = events.find((e) => e.type === 'approval_rejected');
    expect(rejected).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
    });
  });

  it('denied out-of-scope write leaves a pre-existing user edit unchanged', async () => {
    const { projectDir, sessionId } = setupProject();

    // Commit a file, then make it dirty (user edit) before the task starts
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 1;\n');
    execSync('git add . && git commit -m "add existing"', { cwd: projectDir, stdio: 'pipe' });
    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        // Implementer clobbers the user-edited file (out of scope)
        writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    // User's pre-task edit must survive the denial rollback
    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(userEdit);
  });

  it('denied out-of-scope direct write in staging leaves a pre-existing user edit unchanged', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 1;\n');
    execSync('git add . && git commit -m "add existing"', { cwd: projectDir, stdio: 'pipe' });
    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(events.find((event) => event.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
    });
    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(userEdit);
  });

  it('blocks deletion of an already-dirty out-of-scope file', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 1;\n');
    execSync('git add . && git commit -m "add existing"', { cwd: projectDir, stdio: 'pipe' });
    const userEdit = 'export const v = 2; // user edit\n';
    writeFileSync(join(projectDir, 'src/existing.ts'), userEdit);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        unlinkSync(join(projectDir, 'src/existing.ts'));
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, headless: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(events.find((event) => event.type === 'approval_rejected')).toMatchObject({
      type: 'approval_rejected',
      taskId: 'T001',
      actionClass: 'write_out_of_scope',
    });
    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(userEdit);
  });

  it('denied rollback does not erase a clean-at-start file edited during approval', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 1;\n');
    execSync('git add . && git commit -m "add existing"', { cwd: projectDir, stdio: 'pipe' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), concurrentUserEdit);
        return { decision: 'deny', reason: 'out of scope' };
      }),
    };
    const { bus, events } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(concurrentUserEdit);
    expect(events.find((event) => event.type === 'warning')).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('rollback skipped files changed during approval'),
    });
  });

  it('denied direct write leaves user edits made during approval and drops staged implementer output', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/existing.ts'), 'export const v = 1;\n');
    execSync('git add . && git commit -m "add existing"', { cwd: projectDir, stdio: 'pipe' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/existing.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/existing.ts'), concurrentUserEdit);
        return { decision: 'deny', reason: 'out of scope' };
      }),
    };
    const { bus } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    expect(readFileSync(join(projectDir, 'src/existing.ts'), 'utf-8')).toBe(concurrentUserEdit);
  });

  it('approved direct write does not promote staged output over user edits made during approval', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/other.ts'), 'export const v = 1;\n');
    execSync('git add . && git commit -m "add other"', { cwd: projectDir, stdio: 'pipe' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/other.ts'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/other.ts'), concurrentUserEdit);
        return { decision: 'allow', scope: 'once' };
      }),
    };
    const runValidation = vi.fn().mockResolvedValue([]);
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(readFileSync(join(projectDir, 'src/other.ts'), 'utf-8')).toBe(concurrentUserEdit);
    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(events.find((event) => event.type === 'paused_external_changes' && event.conflict?.kind === 'changed-during-approval-promotion')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['src/other.ts'],
        affectedTaskIds: ['T001'],
        safeToContinue: false,
      },
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining('promotion blocked'),
    });
  });

  it('extracted-code approval races ask for user-edit resolution instead of retrying', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/race.ts'), 'export const value = "before";\n');

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/race.ts',
      scope: { inBounds: ['src/race.ts'] },
    });
    const state = implementingState([task]);

    const implementer = createImplementerBase({
      extractsCode: true,
      invoke: vi.fn().mockResolvedValue({
        text: '```ts\nexport const value = "implementer";\n```',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const userEdit = 'export const value = "user";\n';
    const onUserEditConflict = vi.fn().mockResolvedValue('pause');
    let approvalCalls = 0;
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        approvalCalls++;
        if (approvalCalls === 2) {
          writeFileSync(join(projectDir, 'src/race.ts'), userEdit);
        }
        return { decision: 'allow', scope: 'once' };
      }),
      onUserEditConflict,
    };
    const runValidation = vi.fn().mockResolvedValue([]);
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false, tiers: { write_in_scope: 'sticky' } },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(readFileSync(join(projectDir, 'src/race.ts'), 'utf-8')).toBe(userEdit);
    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(onUserEditConflict).not.toHaveBeenCalled();
    expect(result.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
      files: ['src/race.ts'],
      availableActions: ['planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['src/race.ts'],
      },
    });
  });

  it('persists successful confirm reasons in the evidence ledger', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockResolvedValue({
        decision: 'confirm',
        phrase: 'I confirm',
        reason: 'approved scoped source write',
      }),
    };

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        config: makeConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false, tiers: { write_in_scope: 'confirm' } },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { commitStrategy: 'none', maxRetries: 2 },
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

    const ledger = readEvidenceLedger(projectDir, sessionId);
    expect(ledger?.approvals).toContainEqual(expect.objectContaining({
      taskId: 'T001',
      tier: 'confirm',
      actionClass: 'write_in_scope',
      actionDescription: 'create src/hello.ts',
      reason: 'approved scoped source write',
    }));
  });
});

describe('retryAndRecord — retry budget', () => {
  it('local retry on first attempt succeeds → advances task, records local method', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const retry = vi.fn().mockResolvedValue({
      success: true,
      output: 'fixed',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({ callbacks, implementer, bus });
    const setTrackedState = vi.fn();
    const taskBreakdowns: TaskTokenUsage[] = [];

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'tsc failed',
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns,
      setTrackedState,
    });

    expect(res.completed).toBe(true);
    expect(res.state.tasks[0]?.status).toBe('done');
    expect(res.state.currentTaskIndex).toBe(1);

    // Retry event observed with attempt=1.
    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    const firstRetry = retryEvents[0];
    if (firstRetry?.type === 'task_retry') {
      expect(firstRetry.taskId).toBe('T001');
      expect(firstRetry.attempt).toBe(1);
    }

    // Breakdown recorded with method=local.
    expect(taskBreakdowns[0]?.method).toBe('local');
  });

  it('exhausts local retry budget and persists recovery when escalation also fails', async () => {
    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    // Local retry always fails.
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: 'still broken',
      error: 'tsc failed again',
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    // Escalation tiers: intermediate planner is absent in config (default),
    // hint and full also fail.
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({
      callbacks,
      implementer,
      planner,
      bus,
      // Shrink the retry budget to keep the test fast.
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { commitStrategy: 'none', maxRetries: 2 },
      }),
    });

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial tsc failure',
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(res.completed).toBe(false);
    // retry is called maxRetries times (local) plus once on the hint tier before giving up.
    expect(retry.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(res.state.tasks[0]?.status).toBe('in_progress');
    expect(res.state.currentTaskIndex).toBe(0);
    expect(res.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(loadState(wctx.projectDir, wctx.sessionId)?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });

    const complete = busEvents.find((e) => e.type === 'task_completed');
    expect(complete).toBeUndefined();
    expect(busEvents.find((e) => e.type === 'task_failed')).toBeUndefined();

    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    // At least as many retry events as local attempts.
    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
  });
});
