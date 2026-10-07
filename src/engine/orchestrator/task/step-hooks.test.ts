import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-single-task-hooks-trust-home');
});

afterEach(() => {
  cleanupTaskProjects();
  trustHome.restore();
});

describe('runSingleTask — pre_validation hooks', () => {
  it('skips the task (not silently stops) when a pre_validation hook denies', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/hello.ts'],
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    writeFileSync(
      join(projectDir, 'deny-validation.mjs'),
      "console.log(JSON.stringify({ decision: 'deny', message: 'policy: validation gated' }));\n",
    );

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: { projectDir: string }) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const hooks: HooksConfig = {
      pre_validation: [
        {
          kind: 'command',
          command: 'node',
          args: ['deny-validation.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },

          hooks,
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
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

    expect(runValidation).not.toHaveBeenCalled();
    expect(result.tasks[0]?.status).toBe('skipped');
    expect(result.currentTaskIndex).toBe(1);
    expect(result.pendingRecovery).toBeUndefined();
    expect(events.find((e) => e.type === 'task_skipped')).toMatchObject({
      type: 'task_skipped',
      taskId: 'T001',
      reason: 'policy: validation gated',
    });
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(existsSync(join(wctx.workspaceDir, 'src/hello.ts'))).toBe(false);
    expect(
      events.find(
        (e) =>
          e.type === 'warning' &&
          e.message.includes('unvalidated task change(s) after pre_validation denied'),
      ),
    ).toBeDefined();

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')).toMatchObject({
      id: 'T001',
      status: 'skipped',
    });
  });

  it('ends the retry ladder on the skip when the hook denies a retry attempt', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/hello.ts'],
      scope: { inBounds: ['src/hello.ts'] },
    });
    const second = makeTask({ id: 'T002', suggestedFiles: ['src/other.ts'] });
    const state = implementingState([first, second]);

    const calls = join(projectDir, 'hook-calls');
    writeFileSync(
      join(projectDir, 'deny-second-validation.mjs'),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `const calls = ${JSON.stringify(calls)};`,
        "if (existsSync(calls)) console.log(JSON.stringify({ decision: 'deny', message: 'policy: retry gated' }));",
        "else writeFileSync(calls, '1');",
        '',
      ].join('\n'),
    );
    const write =
      (content: string) =>
      async ({ projectDir: runDir }: { projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, 'src/hello.ts'), content);
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      };
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(write('export const hello = 1;\n')),
      retry: vi.fn().mockImplementation(write('export const hello = 2;\n')),
    });
    const runValidation = vi
      .fn()
      .mockResolvedValue([{ stage: 'test', passed: false, output: 'FAIL src/hello.test.ts' }]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const hooks: HooksConfig = {
      pre_validation: [
        {
          kind: 'command',
          command: 'node',
          args: ['deny-second-validation.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },
          hooks,
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
        }),
        validator: { ...createValidator(), runValidation },
      }),
    );
    const result = await runSingleTask({
      wctx,
      task: first,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(runValidation).toHaveBeenCalledTimes(1);
    expect(result.tasks.map((task) => task.status)).toEqual(['skipped', 'pending']);
    expect(result.currentTaskIndex).toBe(1);
    expect(result.pendingRecovery).toBeUndefined();
    expect(events.filter((e) => e.type === 'task_completed')).toEqual([]);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(existsSync(join(wctx.workspaceDir, 'src/hello.ts'))).toBe(false);
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')).toMatchObject({
      status: 'skipped',
    });
  });
});
