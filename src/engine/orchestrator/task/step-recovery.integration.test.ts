import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeBusRecorder,
  makeWorktreeIsolation,
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
import { loadState } from '../../../core/state/persistence.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { EngineEvent, EngineEventOf } from '../../events/types.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import type { Check } from '../../../core/schemas/task.js';
import { createValidator } from '../validation/run.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import { runSingleTask } from './step.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import * as escalationHandle from '../escalation/handle.js';
import { failedRetry } from '../escalation/types.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTaskProjects();
});

const BRIEF_CHECKS: Check[] = [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }];

/** Every brief check command fails, so the brief gate rejects every attempt. */
function failBriefChecks(): void {
  vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
    processError.exitCode({ command: 'tsc', code: 2, stderr: 'test failed', output: '' }),
  );
}

describe('runSingleTask — recovery', () => {
  it("keeps the brief's files in place when the ladder halts on its consult bound", {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
      checks: BRIEF_CHECKS,
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/main.ts'), 'export const main = 999; // broken\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });
    failBriefChecks();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        isolation: makeWorktreeIsolation({ projectDir, sessionId }),
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },

          validation: { endChecks: false, testCommand: 'noop' },
        }),
        planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
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

    expect(result.pendingRecovery?.reason).toBe('consult-bound-spent');
    // Continue replays the brief as a retry carrying the failure, so the files it fails on stay.
    expect(readFileSync(join(wctx.workspaceDir, 'src/main.ts'), 'utf-8')).toBe(
      'export const main = 999; // broken\n',
    );
  });

  it("restores the brief's files to the task start when the ladder halts outside the consult bound", {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts', 'src/extra.ts'],
      scope: { inBounds: ['src/main.ts', 'src/extra.ts'] },
      checks: BRIEF_CHECKS,
    });
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/main.ts'), 'export const main = 999; // broken\n');
        writeFileSync(join(runDir, 'src/extra.ts'), 'export const extra = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: CODEX_BURNED_REFRESH,
        outcome: 'unauthenticated',
        usage: { inputTokens: 2, outputTokens: 0 },
      }),
    });
    failBriefChecks();
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        isolation: makeWorktreeIsolation({ projectDir, sessionId }),
        implementer,
        config: makeConfig({
          workflow: { review: 'task' },

          implementer: { kind: 'cli', tool: 'codex' },
          validation: { endChecks: false, testCommand: 'noop' },
        }),
      }),
    );
    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.pendingRecovery?.reason).toBe('runner-unauthenticated');
    // Every file the brief changed since its task start goes back: the edit and the new file.
    expect(readFileSync(join(wctx.workspaceDir, 'src/main.ts'), 'utf-8')).toBe(
      'export const main = 0;\n',
    );
    expect(existsSync(join(wctx.workspaceDir, 'src/extra.ts'))).toBe(false);
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
      suggestedFiles: ['src/one.ts'],
      scope: { inBounds: ['src/one.ts'] },
      checks: BRIEF_CHECKS,
    });
    const taskTwo = makeTask({
      id: 'T002',
      action: 'modify',
      suggestedFiles: ['src/two.ts'],
      scope: { inBounds: ['src/two.ts'] },
      checks: [{ id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    const state = implementingState([taskOne, taskTwo]);

    const implementer = makeImplementer({
      implement: vi
        .fn()
        .mockImplementation(async ({ task, projectDir: runDir }: ImplementerOptions) => {
          if (task.id === 'T001') {
            writeFileSync(join(runDir, 'src/one.ts'), 'export const one = 999; // broken\n');
          } else {
            writeFileSync(join(runDir, 'src/two.ts'), 'export const two = 1;\n');
          }
          return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
        }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });

    // The whole-tree check observes src/one.ts every time it runs; task 1 fails
    // forever, task 2 passes. Each call records what src/one.ts looks like on disk.
    const oneSeenByValidation: string[] = [];
    vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (_cmd, _args, options) => {
      const dir = options?.cwd ?? projectDir;
      oneSeenByValidation.push(readFileSync(join(dir, 'src/one.ts'), 'utf-8'));
      if (readFileSync(join(dir, 'src/two.ts'), 'utf-8') === 'export const two = 1;\n') {
        return { stdout: '', stderr: '', code: 0 };
      }
      throw processError.exitCode({ command: 'tsc', code: 2, stderr: 'test failed', output: '' });
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        isolation: makeWorktreeIsolation({ projectDir, sessionId }),
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },

          validation: { endChecks: false, testCommand: 'noop' },
        }),
        planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      }),
    );

    let taskOneStart: ChangedFilesSnapshot | undefined;
    const afterTaskOne = await runSingleTask({
      wctx,
      task: taskOne,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
      onTaskStartSnapshot: (startState, snapshot) => {
        taskOneStart = snapshot;
        return startState;
      },
    });

    // Task 1 exhausts the ladder; its broken change stays for a Continue to start from.
    expect(afterTaskOne.pendingRecovery?.reason).toBe('consult-bound-spent');
    expect(readFileSync(join(wctx.workspaceDir, 'src/one.ts'), 'utf-8')).toBe(
      'export const one = 999; // broken\n',
    );

    // Skip the exhausted task via the real recovery action: the skip restores its files.
    const skipResult = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: {
        ...afterTaskOne,
        workspace: {
          kind: 'worktree',
          path: wctx.workspaceDir,
          base: { snapshotId: 'workspace-base', head: null },
        },
        changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: taskOneStart },
      },
      action: 'skip-current-task',
      bus,
    });
    expect(skipResult.ok).toBe(true);
    expect(skipResult.state.tasks[0]?.status).toBe('skipped');
    expect(skipResult.state.currentTaskIndex).toBe(1);
    expect(readFileSync(join(wctx.workspaceDir, 'src/one.ts'), 'utf-8')).toBe(
      'export const one = 0;\n',
    );

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

// A Biome run whose output opens with a config notice before the brief's own diagnostic,
// the shape a real run's consult-bound panel truncated.
const BIOME_NOTICE_THEN_FORMAT = [
  'biome.json:38:13 deserialize  DEPRECATED  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '  i The use of the recommended field has been deprecated, and will removed in the next major version of Biome. Use preset instead.',
  '',
  'src/main.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '  × Formatter would have printed the following content:',
  '',
  'check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '  × Some errors were emitted while running checks.',
].join('\n');

describe('runSingleTask — the consult-bound halt names the last failure', () => {
  it('names the failing check as the last diagnosis', {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
      checks: BRIEF_CHECKS,
    });
    let writes = 0;
    const write = (runDir: string) => {
      writes += 1;
      writeFileSync(join(runDir, 'src/main.ts'), `export const main = [ ${writes} ];\n`);
    };
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        write(runDir);
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        write(runDir);
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({
        command: 'biome',
        code: 1,
        stderr: BIOME_NOTICE_THEN_FORMAT,
        output: '',
      }),
    );
    const { bus } = makeBusRecorder();
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        isolation: makeWorktreeIsolation({ projectDir, sessionId }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },
        }),
        planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      }),
    );

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.pendingRecovery?.reason).toBe('consult-bound-spent');
    expect(result.pendingRecovery?.details[0]).toBe('Last diagnosis: check K1 failed');
    // The config notice that opens the output does not crowd out the brief's own diagnostic.
    expect(String(result.pendingRecovery?.facts?.['failingOutput'])).toContain(
      'src/main.ts format',
    );
  });
});

describe('runSingleTask — the retry-exhausted halt keeps the check output', () => {
  it('quotes the failing check when the ladder names no last error', {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
      checks: BRIEF_CHECKS,
    });
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/main.ts'), 'export const main = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    failBriefChecks();
    vi.spyOn(escalationHandle, 'handleRetryAndEscalation').mockImplementation(
      async ({ currentState }) => ({ state: currentState, result: failedRetry(1) }),
    );
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        isolation: makeWorktreeIsolation({ projectDir, sessionId }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus: makeBusRecorder().bus,
        config: makeConfig({ workflow: { review: 'task' } }),
      }),
    );

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(result.pendingRecovery?.details[0]).toBe(
      'Last error: check K1 did not pass (fail): test failed',
    );
  });
});

describe('runSingleTask — a layout-only lint failure', () => {
  it('formats every file the brief wrote across its attempts, so the layout costs no consult', {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({
      'biome.json': '{}\n',
      'src/a.ts': 'export const a = 0;\n',
      'src/a.test.ts': "import { a } from './a.js';\n",
      'src/b.ts': 'export const b = 0;\n',
    });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/a.ts', 'src/a.test.ts', 'src/b.ts'],
      scope: { inBounds: ['src/a.ts', 'src/a.test.ts', 'src/b.ts'] },
      checks: [
        { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true },
        { id: 'K2', kind: 'cmd', value: 'biome check .', required: true },
      ],
    });
    // Attempt 1 writes an unformatted test and leaves a type error in src/b.ts; the
    // local retry fixes src/b.ts only, as T008's attempts 8 to 10 did in a real run.
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/a.ts'), 'export const a = 1;\n');
        writeFileSync(join(runDir, 'src/a.test.ts'), 'UNFORMATTED\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/b.ts'), 'export const b = 1;\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const commands: string[] = [];
    const runCommand: ValidationCommandRunner = async (cmd, args, options) => {
      const line = [cmd, ...args].join(' ');
      commands.push(line);
      const dir = options?.cwd ?? projectDir;
      const read = (file: string) => readFileSync(join(dir, file), 'utf-8');
      if (line === 'tsc --noEmit' && read('src/b.ts') !== 'export const b = 1;\n') {
        throw processError.exitCode({
          command: line,
          code: 2,
          stderr: '',
          output: "src/b.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.",
        });
      }
      if (line.startsWith('npx biome format --write ')) {
        for (const file of args.slice(3)) {
          if (read(file) === 'UNFORMATTED\n') writeFileSync(join(dir, file), 'export {};\n');
        }
      }
      if (line === 'biome check .' && read('src/a.test.ts') === 'UNFORMATTED\n') {
        throw processError.exitCode({
          command: line,
          code: 1,
          stderr:
            'src/a.test.ts format ━━━━━━━━━━\n\n  × Formatter would have printed the following content:',
          output: '',
        });
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const consult = vi.fn(() => guidanceConsult());
    const { bus, events } = makeBusRecorder();
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        isolation: makeWorktreeIsolation({ projectDir, sessionId }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },
        }),
        planner: makePlanner({ typedCall: consultCallAnswering(consult) }),
        validator: createValidator({ runCommand }),
      }),
    );
    vi.spyOn(commandRunner, 'runCommand').mockImplementation(runCommand);

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.pendingRecovery).toBeUndefined();
    expect(result.tasks[0]?.status).toBe('done');
    expect(consult).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'task_escalating')).toEqual([]);
    expect(readFileSync(join(wctx.workspaceDir, 'src/a.test.ts'), 'utf-8')).toBe('export {};\n');
    const formatted = events.find(
      (event): event is EngineEventOf<'warning'> =>
        event.type === 'warning' && event.code === 'validation_formatted',
    );
    expect(formatted?.message).toContain('src/a.test.ts');
  });
});

describe('runSingleTask — signed-out runner', () => {
  it('halts on an unauthenticated first attempt with the login command instead of retrying or escalating', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['src/main.ts'] });
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
          workflow: { review: 'task' },

          implementer: { kind: 'cli', tool: 'codex' },
          validation: { endChecks: false, testCommand: 'noop' },
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
    const retryResult = await applyRecoveryAction({
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
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
      checks: BRIEF_CHECKS,
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/main.ts'), 'export const main = 999; // broken\n');
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
    failBriefChecks();
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
          workflow: { review: 'task' },

          implementer: { kind: 'cli', tool: 'codex' },
          validation: { endChecks: false, testCommand: 'noop' },
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
    // The failed login stops further retries.
    expect(implementer.retry).toHaveBeenCalledTimes(1);
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

/**
 * The halt's error row carries the reset as the instant codex named, for the row to spell the way
 * the header does; its stored words name no clock, and codex's own words drop theirs.
 */
function expectResetNamedOnce(events: EngineEvent[]): void {
  const row = events.find(
    (event) => event.type === 'error' && event.message.includes('hit its usage limit'),
  );
  expect(row?.type === 'error' && row.resetAt).toBe(new Date(2026, 7, 8, 15, 27).toISOString());
  const text = row?.type === 'error' ? row.message : '';
  expect(text).toContain(
    "(runner reported: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.)",
  );
  expect(text).not.toMatch(/15:27|3:27 PM/);
}

describe('runSingleTask — usage-limited runner', () => {
  it('halts on a first-attempt usage limit with the reset time instead of retrying, escalating, or advising a re-login', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['src/main.ts'] });
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
          workflow: { review: 'task' },

          implementer: { kind: 'cli', tool: 'codex' },
          validation: { endChecks: false, testCommand: 'noop' },
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
    expect(result.pendingRecovery?.message).not.toMatch(/log ?in|log ?out/i);
    expect(result.pendingRecovery?.details.join('\n')).toContain(CODEX_USAGE_LIMIT);
    expect(result.pendingRecovery?.facts?.resetsAt).toMatch(/^2026-08-08T/);
    expect(result.pendingRecovery?.availableActions).toEqual([
      'retry-same-worker',
      'retry-later',
      'skip-current-task',
      'end-run',
    ]);

    expect(implementer.retry).not.toHaveBeenCalled();

    expect(events.find((event) => event.type === 'recovery_prompted')).toMatchObject({
      reason: 'runner-usage-limit',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
    });
    expectResetNamedOnce(events);

    // Once the limit has reset, the retry action resumes the same task.
    const retryResult = await applyRecoveryAction({
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
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
      checks: BRIEF_CHECKS,
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, 'src/main.ts'), 'export const main = 999; // broken\n');
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
    failBriefChecks();
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
          workflow: { review: 'task' },

          implementer: { kind: 'cli', tool: 'codex' },
          validation: { endChecks: false, testCommand: 'noop' },
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
    // The exhausted quota stops further retries.
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expectResetNamedOnce(events);
    // The failing attempt's changes were rolled back like any exhausted task.
    expect(readFileSync(join(projectDir, 'src/main.ts'), 'utf-8')).toBe('export const main = 0;\n');
  });
});
