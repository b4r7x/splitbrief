import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { loadState } from '../../../core/state/persistence.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { applyRecoveryAction } from '../recovery/actions.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — recovery', () => {
  it('raises a user-edit-conflict recovery when a foreign edit appears in the failing universe', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'src/helper.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(),
    });
    const runValidation = vi.fn().mockImplementation(async () => {
      writeFileSync(join(projectDir, 'src/helper.ts'), 'export const helper = 2; // user edit\n');
      return [{ stage: 'test' as const, passed: false, error: 'test failed' }];
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
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
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

    expect(result.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T001',
    });
    expect(result.pendingRecovery?.files).toContain('src/helper.ts');
    expect(implementer.retry).not.toHaveBeenCalled();
    expect(result.tasks[0]?.status).not.toBe('done');
    expect(events.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      type: 'recovery_prompted',
      reason: 'user-edit-conflict',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
    });
  });

  it('restores failing task changes to the pre-task state when the retry ladder exhausts', {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 999; // broken\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });
    const runValidation = vi
      .fn()
      .mockResolvedValue([{ stage: 'test' as const, passed: false, error: 'test failed' }]);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { maxRetries: 1 },
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

    expect(result.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(readFileSync(join(projectDir, 'src/main.ts'), 'utf-8')).toBe('export const main = 0;\n');
  });

  it("does not leak a skipped task's exhausted changes into the next task's validation", {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({
      'src/one.ts': 'export const one = 0;\n',
      'src/two.ts': 'export const two = 0;\n',
    });
    const taskOne = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/one.ts',
      scope: { inBounds: ['src/one.ts'] },
    });
    const taskTwo = makeTask({
      id: 'T002',
      action: 'modify',
      file: 'src/two.ts',
      scope: { inBounds: ['src/two.ts'] },
    });
    const state = implementingState([taskOne, taskTwo]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ task }: ImplementerOptions) => {
        // Task 1 writes broken code; task 2 writes clean code.
        if (task.id === 'T001') {
          writeFileSync(join(projectDir, 'src/one.ts'), 'export const one = 999; // broken\n');
        } else {
          writeFileSync(join(projectDir, 'src/two.ts'), 'export const two = 1;\n');
        }
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });

    // The whole-tree validator observes src/one.ts every time it runs; task 1 fails
    // forever, task 2 passes. Each call records what src/one.ts looks like on disk.
    const oneSeenByValidation: string[] = [];
    const runValidation = vi.fn().mockImplementation(async () => {
      oneSeenByValidation.push(readFileSync(join(projectDir, 'src/one.ts'), 'utf-8'));
      if (readFileSync(join(projectDir, 'src/two.ts'), 'utf-8') === 'export const two = 1;\n') {
        return [{ stage: 'test' as const, passed: true }];
      }
      return [{ stage: 'test' as const, passed: false, error: 'test failed' }];
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      callbacks,
      implementer,
      bus,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
        workflow: { maxRetries: 1 },
      }),
      validator: { ...createValidator(), runValidation },
    });

    const afterTaskOne = await runSingleTask({
      wctx,
      task: taskOne,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    // Task 1 exhausts the ladder and its broken change is restored to the pre-task state.
    expect(afterTaskOne.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(readFileSync(join(projectDir, 'src/one.ts'), 'utf-8')).toBe('export const one = 0;\n');

    // Skip the exhausted task via the real recovery action, then run task 2.
    const skipResult = applyRecoveryAction({
      projectDir,
      sessionId,
      state: afterTaskOne,
      action: 'skip-current-task',
      bus,
    });
    expect(skipResult.ok).toBe(true);
    expect(skipResult.state.tasks[0]?.status).toBe('skipped');
    expect(skipResult.state.currentTaskIndex).toBe(1);

    const validationsBeforeTaskTwo = oneSeenByValidation.length;

    const afterTaskTwo = await runSingleTask({
      wctx,
      task: taskTwo,
      index: 1,
      totalTasks: 2,
      state: skipResult.state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    // Task 2 completes; its validation never saw task 1's abandoned half-fix.
    expect(afterTaskTwo.tasks[1]?.status).toBe('done');
    expect(afterTaskTwo.pendingRecovery).toBeUndefined();
    const validatedDuringTaskTwo = oneSeenByValidation.slice(validationsBeforeTaskTwo);
    expect(validatedDuringTaskTwo.length).toBeGreaterThan(0);
    for (const observed of validatedDuringTaskTwo) {
      expect(observed).toBe('export const one = 0;\n');
    }
  });
});

// Captured verbatim from `codex exec --json` (codex-cli 0.146.0, 2026-08-06).
const CODEX_BURNED_REFRESH =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';

describe('runSingleTask — signed-out runner', () => {
  it('halts on an unauthenticated first attempt with the login command instead of retrying or escalating', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', action: 'create', file: 'src/main.ts' });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: CODEX_BURNED_REFRESH,
        outcome: 'unauthenticated',
        usage: { inputTokens: 3, outputTokens: 0 },
      }),
      retry: vi.fn(),
    });
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        planner,
        bus,
        config: makeConfig({
          implementer: { kind: 'cli', tool: 'codex' },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
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

    expect(result.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
      taskId: 'T001',
    });
    expect(result.pendingRecovery?.message).toContain('OpenAI Codex CLI is signed out');
    expect(result.pendingRecovery?.message).toContain('codex logout');
    expect(result.pendingRecovery?.message).toContain('codex login');
    expect(result.pendingRecovery?.details.join('\n')).toContain(CODEX_BURNED_REFRESH);
    expect(result.pendingRecovery?.availableActions).toContain('retry-same-worker');

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(planner.escalateHint).not.toHaveBeenCalled();
    expect(planner.escalateFull).not.toHaveBeenCalled();

    const errorEvent = events.find(
      (event) => event.type === 'error' && event.message.includes('codex login'),
    );
    expect(errorEvent).toBeDefined();
    expect(events.find((event) => event.type === 'recovery_prompted')).toMatchObject({
      reason: 'runner-unauthenticated',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
    });

    // After the user logs in externally, the retry action resumes the same task.
    const retryResult = applyRecoveryAction({
      projectDir,
      sessionId,
      state: result,
      action: 'retry-same-worker',
      bus,
    });
    expect(retryResult.ok).toBe(true);
    expect(retryResult.state.pendingRecovery).toBeUndefined();
  });

  it('halts mid-ladder when a retry attempt reports unauthenticated instead of escalating to the planner', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 999; // broken\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      // The login expires between the first attempt and the retry ladder.
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: CODEX_BURNED_REFRESH,
        outcome: 'unauthenticated',
        usage: { inputTokens: 2, outputTokens: 0 },
      }),
    });
    const planner = makePlanner();
    const runValidation = vi
      .fn()
      .mockResolvedValue([{ stage: 'test' as const, passed: false, error: 'test failed' }]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        planner,
        bus,
        config: makeConfig({
          implementer: { kind: 'cli', tool: 'codex' },
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
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

    expect(result.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
      taskId: 'T001',
    });
    // One attempt proved the login is dead; further retries and planner tiers never ran.
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(planner.escalateHint).not.toHaveBeenCalled();
    expect(planner.escalateFull).not.toHaveBeenCalled();
    expect(
      events.find((event) => event.type === 'error' && event.message.includes('codex login')),
    ).toBeDefined();
    // The failing attempt's changes were rolled back like any exhausted task.
    expect(readFileSync(join(projectDir, 'src/main.ts'), 'utf-8')).toBe('export const main = 0;\n');
  });
});

// Captured live from `codex exec --json` on 2026-08-06 against an account at
// its usage limit; codex fails the turn with this message until the reset.
const CODEX_USAGE_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";

describe('runSingleTask — usage-limited runner', () => {
  it('halts on a first-attempt usage limit with the reset time instead of retrying, escalating, or advising a re-login', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', action: 'create', file: 'src/main.ts' });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: CODEX_USAGE_LIMIT,
        outcome: 'usage-limit',
        usage: { inputTokens: 3, outputTokens: 0 },
      }),
      retry: vi.fn(),
    });
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        planner,
        bus,
        config: makeConfig({
          implementer: { kind: 'cli', tool: 'codex' },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
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

    expect(result.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      taskId: 'T001',
    });
    expect(result.pendingRecovery?.message).toContain('hit its usage limit');
    expect(result.pendingRecovery?.message).toContain('Aug 8, 2026, 3:27 PM');
    expect(result.pendingRecovery?.message).not.toMatch(/log ?in|log ?out/i);
    expect(result.pendingRecovery?.details.join('\n')).toContain(CODEX_USAGE_LIMIT);
    expect(result.pendingRecovery?.facts?.resetsAt).toMatch(/^2026-08-08T/);
    expect(result.pendingRecovery?.availableActions).toContain('retry-same-worker');
    expect(result.pendingRecovery?.availableActions).toContain('pause-run');

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(planner.escalateHint).not.toHaveBeenCalled();
    expect(planner.escalateFull).not.toHaveBeenCalled();

    expect(events.find((event) => event.type === 'recovery_prompted')).toMatchObject({
      reason: 'runner-usage-limit',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
    });

    // Once the limit has reset, the retry action resumes the same task.
    const retryResult = applyRecoveryAction({
      projectDir,
      sessionId,
      state: result,
      action: 'retry-same-worker',
      bus,
    });
    expect(retryResult.ok).toBe(true);
    expect(retryResult.state.pendingRecovery).toBeUndefined();
  });

  it('halts mid-ladder when a retry hits the limit instead of silently escalating to the planner', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 999; // broken\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      // The quota runs out between the first attempt and the retry ladder.
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: CODEX_USAGE_LIMIT,
        outcome: 'usage-limit',
        usage: { inputTokens: 2, outputTokens: 0 },
      }),
    });
    const planner = makePlanner();
    const runValidation = vi
      .fn()
      .mockResolvedValue([{ stage: 'test' as const, passed: false, error: 'test failed' }]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        planner,
        bus,
        config: makeConfig({
          implementer: { kind: 'cli', tool: 'codex' },
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
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

    expect(result.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      taskId: 'T001',
    });
    // One attempt proved the quota is gone; further retries and planner tiers never ran.
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(planner.escalateHint).not.toHaveBeenCalled();
    expect(planner.escalateFull).not.toHaveBeenCalled();
    expect(
      events.find(
        (event) => event.type === 'error' && event.message.includes('hit its usage limit'),
      ),
    ).toBeDefined();
    // The failing attempt's changes were rolled back like any exhausted task.
    expect(readFileSync(join(projectDir, 'src/main.ts'), 'utf-8')).toBe('export const main = 0;\n');
  });
});
